import * as vscode from 'vscode';
import { getALObjectFromPath } from './alFileHelper';
import { alTestController, outputWriter } from './extension';
import { testItemIsPageScript } from './pageScripting';
import { getTestCodeunitsIncludedInRequest } from './testController';

// Track which test items have been marked with results by the real-time parser
const markedTestItems = new Set<vscode.TestItem>();

// Parser state machine states
enum ParserState {
    IDLE = 'IDLE',
    CODEUNIT_RUNNING = 'CODEUNIT_RUNNING',
    COLLECTING_ERROR_MESSAGE = 'COLLECTING_ERROR_MESSAGE',
    COLLECTING_CALLSTACK = 'COLLECTING_CALLSTACK'
}

/**
 * Creates a parser that processes terminal output in real-time and updates test run status.
 * The parser handles chunked data from the terminal shell integration, buffers incomplete lines,
 * and updates test items through the VS Code Test API as tests execute.
 *
 * @param run - The VS Code test run to update with progress
 * @param request - The test run request containing which tests are being executed
 * @returns A function that processes terminal output data chunks
 */
export function createOutputParser(run: vscode.TestRun, request: vscode.TestRunRequest): (data: string) => void {
    // Parser state
    let state: ParserState = ParserState.IDLE;
    let currentCodeunit: vscode.TestItem | undefined; // Codeunit whose results are being reported
    let runningCodeunit: vscode.TestItem | undefined; // Codeunit currently executing in BC
    let pendingFailedTest: vscode.TestItem | undefined;
    let errorMessageBuffer = '';

    // Get the tests to start for a given codeunit based on what's included in the request
    const getTestsToStart = (codeunit: vscode.TestItem): vscode.TestItem[] => {
        const testsToStart: vscode.TestItem[] = [];

        // If request.include is undefined, we're running all tests - start all children
        if (!request.include) {
            codeunit.children.forEach(test => testsToStart.push(test));
        }
        // If the codeunit itself is included, start all its children
        else if (request.include.includes(codeunit)) {
            codeunit.children.forEach(test => testsToStart.push(test));
        } else {
            // Otherwise, only start the specific tests that are included
            codeunit.children.forEach(test => {
                if (request.include?.includes(test)) {
                    testsToStart.push(test);
                }
            });
        }

        return testsToStart;
    };

    // Get test codeunits being executed, sorted by object ID (BC runs them in ID order)
    const getSortedCodeunits = (): vscode.TestItem[] => {
        const codeunits: vscode.TestItem[] = [];

        // Get codeunits from the request (or all codeunits if running all tests)
        let testCodeunits: vscode.TestItem[];
        if (!request.include) {
            // Running all tests - get all test codeunits
            testCodeunits = [];
            alTestController.items.forEach(testItem => {
                testCodeunits.push(testItem);
            });
        } else {
            testCodeunits = getTestCodeunitsIncludedInRequest(request);
        }

        testCodeunits.forEach(testItem => {
            if (!testItemIsPageScript(testItem) && testItem.children.size > 0) {
                codeunits.push(testItem);
            }
        });

        // Sort by object ID extracted from URI
        codeunits.sort((a, b) => {
            const getObjectId = (item: vscode.TestItem): number => {
                if (item.uri) {
                    const obj = getALObjectFromPath(item.uri.fsPath);
                    if (obj && obj.id) {
                        return obj.id;
                    }
                }
                return 0;
            };

            return getObjectId(a) - getObjectId(b);
        });

        return codeunits;
    };

    // Find a test by name in the given codeunit
    const findTestInCodeunit = (codeunit: vscode.TestItem, testName: string): vscode.TestItem | undefined => {
        let found: vscode.TestItem | undefined;
        codeunit.children.forEach(test => {
            if (test.label === testName) {
                found = test;
            }
        });
        return found;
    };

    // Find a codeunit by ID and name
    const findCodeunit = (codeunitId: string, codeunitName: string): vscode.TestItem | undefined => {
        const sortedCodeunits = getSortedCodeunits();
        const fullName = `${codeunitId} ${codeunitName}`;

        for (const testItem of sortedCodeunits) {
            if (testItem.label === fullName ||
                testItem.label === codeunitName ||
                testItem.id.includes(codeunitId)) {
                return testItem;
            }
        }
        return undefined;
    };

    // Get the next codeunit after the given one
    const getNextCodeunit = (current: vscode.TestItem): vscode.TestItem | undefined => {
        const sortedCodeunits = getSortedCodeunits();
        const currentIndex = sortedCodeunits.indexOf(current);
        if (currentIndex >= 0 && currentIndex + 1 < sortedCodeunits.length) {
            return sortedCodeunits[currentIndex + 1];
        }
        return undefined;
    };

    // Start all tests in a codeunit (mark as "started" in UI)
    const startCodeunitTests = (codeunit: vscode.TestItem): void => {
        const testsToStart = getTestsToStart(codeunit);
        testsToStart.forEach(test => {
            if (!markedTestItems.has(test)) {
                run.started(test);
            }
        });
    };

    // Finalize a failed test with collected error message
    const finalizeFailedTest = (): void => {
        if (pendingFailedTest) {
            const errorMsg = errorMessageBuffer.trim() || 'Test failed';
            run.failed(pendingFailedTest, new vscode.TestMessage(errorMsg));
            markedTestItems.add(pendingFailedTest);
            pendingFailedTest = undefined;
            errorMessageBuffer = '';
            state = ParserState.CODEUNIT_RUNNING;
        }
    };



    /**
     * Processes terminal data with cursor positioning codes and returns complete lines.
     * For wrapped terminals, text is split across multiple lines with cursor positioning.
     * Lines starting with cursor positioning codes (\x1b[row;colH) are continuations.
     * Continuation fragments typically have 1-3 character overlap with the previous fragment
     * (showing what was already visible when cursor repositions).
     */
    const processTerminalData = (data: string): string[] => {
        // Strip OSC sequences (shell integration markers)
        let text = data.replace(/\x1b\][^\x07]*\x07/g, '');

        // Split into raw lines
        const rawLines = text.split('\n');
        const lines: string[] = [];
        let currentLine = '';

        for (const rawLine of rawLines) {
            // Remove \r and color codes, but keep cursor positioning for detection
            const lineWithoutColors = rawLine
                .replace(/\r/g, '')
                .replace(/\x1b\[[0-9;]*m/g, '');  // Remove color codes only

            // Check if line starts with cursor positioning (continuation line)
            const isContinuation = /^\x1b\[[0-9;]+H/.test(lineWithoutColors);

            if (isContinuation) {
                // Strip the cursor positioning
                const fragment = lineWithoutColors.replace(/\x1b\[[0-9;]+H/, '').trimEnd();

                // Detect overlap: check if first 1-3 chars of fragment match end of current line
                let overlapLength = 0;
                for (let len = 1; len <= Math.min(3, fragment.length, currentLine.length); len++) {
                    if (currentLine.endsWith(fragment.substring(0, len))) {
                        overlapLength = len;
                    }
                }

                // Append fragment, skipping the overlapping portion
                currentLine += fragment.substring(overlapLength);
            } else {
                // New logical line - flush previous and start new
                const textOnly = lineWithoutColors.trimEnd();
                if (textOnly || currentLine) {
                    if (currentLine) {
                        lines.push(currentLine);
                    }
                    currentLine = textOnly;
                }
            }
        }

        // Flush any remaining content
        if (currentLine) {
            lines.push(currentLine);
        }

        return lines;
    };

    /**
     * Process a single complete line of output
     */
    const processLine = (line: string): void => {
        // Strip any remaining ANSI codes
        const cleanLine = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

        // Check for PowerShell warnings
        const warningMatch = cleanLine.match(/AL Test Runner WARNING: (.+)/);
        if (warningMatch) {
            outputWriter.writeError(warningMatch[1]);
            return;
        }

        // STATE: IDLE - Waiting for test execution to start
        if (state === ParserState.IDLE) {
            // Look for "Connecting to" - first codeunit starts executing
            if (/^Connecting to https?:\/\//.test(cleanLine)) {
                const sortedCodeunits = getSortedCodeunits();
                if (sortedCodeunits.length > 0) {
                    runningCodeunit = sortedCodeunits[0];
                    startCodeunitTests(runningCodeunit);

                    // Switch focus to Test Results panel
                    vscode.commands.executeCommand('workbench.panel.testResults.view.focus');
                }
                return;
            }
        }

        // Check for codeunit completion line (can appear in any state)
        // Format: "  Codeunit 70450 LIB Library Member Tests Success (3.096 seconds)"
        const codeunitMatch = cleanLine.match(/^\s+Codeunit\s+(\d+)\s+(.+?)\s+(Success|Failure)\s+\(/);
        if (codeunitMatch) {
            // Finalize any pending failed test from previous codeunit
            finalizeFailedTest();

            const codeunitId = codeunitMatch[1];
            const codeunitName = codeunitMatch[2].trim();

            // This codeunit just finished - its results follow
            const finishedCodeunit = findCodeunit(codeunitId, codeunitName);
            if (finishedCodeunit) {
                currentCodeunit = finishedCodeunit;

                // Start next codeunit (BC just started executing it)
                const nextCodeunit = getNextCodeunit(finishedCodeunit);
                if (nextCodeunit) {
                    runningCodeunit = nextCodeunit;
                    startCodeunitTests(nextCodeunit);
                }

                state = ParserState.CODEUNIT_RUNNING;
            }
            return;
        }

        // STATE: CODEUNIT_RUNNING or COLLECTING_* - Process test results
        if (state === ParserState.CODEUNIT_RUNNING ||
            state === ParserState.COLLECTING_ERROR_MESSAGE ||
            state === ParserState.COLLECTING_CALLSTACK) {

            // Check for test function result
            // Format: "    Testfunction TestCreateLibraryMember Success (0.043 seconds)"
            const testMatch = cleanLine.match(/^\s+Testfunction\s+(.+?)\s+(Success|Failure)\s+\(/);
            if (testMatch) {
                // Finalize any pending failed test before processing this one
                finalizeFailedTest();

                const testName = testMatch[1];
                const testResult = testMatch[2];

                if (currentCodeunit) {
                    const test = findTestInCodeunit(currentCodeunit, testName);
                    if (test) {
                        if (testResult === 'Success') {
                            run.passed(test);
                            markedTestItems.add(test);
                        } else {
                            // Store failed test and prepare to collect error details
                            pendingFailedTest = test;
                            errorMessageBuffer = '';
                            state = ParserState.COLLECTING_ERROR_MESSAGE;
                        }
                    }
                }
                return;
            }

            // Check for error section header (6-space indent)
            if (cleanLine.match(/^\s{6}Error:/)) {
                state = ParserState.COLLECTING_ERROR_MESSAGE;
                errorMessageBuffer = ''; // Start fresh
                return;
            }

            // Check for call stack header (6-space indent)
            if (cleanLine.match(/^\s{6}Call Stack:/)) {
                state = ParserState.COLLECTING_CALLSTACK;
                if (errorMessageBuffer) {
                    errorMessageBuffer += '\n';
                }
                return;
            }

            // Collect error/callstack content (8-space indent)
            if (state === ParserState.COLLECTING_ERROR_MESSAGE || state === ParserState.COLLECTING_CALLSTACK) {
                if (cleanLine.match(/^\s{8}\S/)) {
                    const messageLine = cleanLine.trim();
                    if (messageLine) {
                        errorMessageBuffer += messageLine + '\n';
                    }
                    return;
                }
            }
        }
    };

    return (data: string) => {
        // Process terminal data to handle wrapped output
        const completeLines = processTerminalData(data);

        // Process each complete line
        completeLines.forEach((line) => {
            processLine(line);
        });
    };
}

/**
 * Checks if a test item has already been marked with a result by the real-time parser.
 * This prevents duplicate result marking when XML results are processed afterward.
 */
export function testItemWasMarkedByParser(testItem: vscode.TestItem): boolean {
    return markedTestItems.has(testItem);
}

/**
 * Clears the set of marked test items. Should be called before starting a new test run.
 */
export function clearMarkedTestItems(): void {
    markedTestItems.clear();
}
