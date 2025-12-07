import * as vscode from 'vscode';
import { getALObjectFromPath } from './alFileHelper';
import { alTestController, outputWriter } from './extension';
import { testItemIsPageScript } from './pageScripting';
import { getTestCodeunitsIncludedInRequest } from './testController';

// Track which test items have been marked with results by the real-time parser
const markedTestItems = new Set<vscode.TestItem>();

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
    let currentCodeunit: vscode.TestItem | undefined;
    let hasStartedFirstCodeunit = false;
    let currentFailedTest: vscode.TestItem | undefined;
    let failureMessage = '';
    let buffer = ''; // Buffer for incomplete lines
    let pendingCodeunitSwitch: vscode.TestItem | undefined; // Codeunit to switch to after processing current batch

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

    // Get test codeunits being executed, sorted by object ID (BC runs them in ID order, not alphabetical)
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

    const processLine = (line: string) => {
        // Look for "Connecting to" to start all tests in the first codeunit being executed
        if (!hasStartedFirstCodeunit && /^Connecting to https?:\/\//.test(line)) {
            const sortedCodeunits = getSortedCodeunits();
            if (sortedCodeunits.length > 0) {
                currentCodeunit = sortedCodeunits[0];
                hasStartedFirstCodeunit = true;

                // Switch focus to Test Results panel now that tests are actually starting
                vscode.commands.executeCommand('workbench.panel.testResults.view.focus');

                const testsToStart = getTestsToStart(currentCodeunit);
                testsToStart.forEach(test => {
                    run.started(test);
                });
            }
            return;
        }

        // Process test results (before handling codeunit transitions)
        // Look for individual test results: "    Testfunction TestCreateLibraryMember Success (0.02 seconds)"
        const testMatch = line.match(/^\s+Testfunction\s+(.+?)\s+(Success|Failure)\s+\(/);
        if (testMatch) {
            const testName = testMatch[1];
            const testResult = testMatch[2];

            // If we don't have a current codeunit yet, we might need to wait for it
            if (!currentCodeunit) {
                return;
            }

            // Find the test item and mark it with result
            currentCodeunit.children.forEach(test => {
                if (test.label === testName) {
                    if (testResult === 'Success') {
                        run.passed(test);
                        markedTestItems.add(test);
                    } else {
                        // Store failed test to collect error details
                        currentFailedTest = test;
                        failureMessage = '';
                    }
                }
            });
            return;
        }

        // Collect failure details - Error line starts with "      Error:"
        if (currentFailedTest && line.match(/^\s{6}Error:/)) {
            failureMessage = '';
            return;
        }

        // Collect Call Stack - starts with "      Call Stack:"
        if (currentFailedTest && line.match(/^\s{6}Call Stack:/)) {
            if (failureMessage) {
                failureMessage += '\n';
            }
            return;
        }

        // Collect failure message lines (indented with 8 spaces)
        if (currentFailedTest && line.match(/^\s{8}\S/)) {
            const messageLine = line.trim();
            if (messageLine) {
                failureMessage += messageLine + '\n';
            }
            return;
        }

        // When we hit the next test function or codeunit, mark the failed test with collected details
        if (currentFailedTest && (line.match(/^\s+Codeunit\s+\d+/) || line.match(/^\s+Testfunction\s+/))) {
            const errorMsg = failureMessage.trim() || 'Test failed';
            run.failed(currentFailedTest, new vscode.TestMessage(errorMsg));
            markedTestItems.add(currentFailedTest);
            currentFailedTest = undefined;
            failureMessage = '';

            // Process this line again since it might be the next test starting
            processLine(line);
            return;
        }

        // Look for completed codeunit output: "  Codeunit 70450 LIB Library Member Tests Success (0.044 seconds)"
        // Don't switch immediately - mark it as pending and switch after processing all lines in this batch
        const codeunitMatch = line.match(/^\s+Codeunit\s+(\d+)\s+(.+?)\s+(Success|Failure)\s+\(/);
        if (codeunitMatch) {
            const codeunitId = codeunitMatch[1];
            const codeunitName = codeunitMatch[2].trim();
            const fullName = `${codeunitId} ${codeunitName}`;

            const sortedCodeunits = getSortedCodeunits();
            let currentIndex = -1;

            // Find which codeunit just completed
            for (let i = 0; i < sortedCodeunits.length; i++) {
                const testItem = sortedCodeunits[i];
                if (testItem.label === fullName || testItem.label === codeunitName || testItem.id.includes(codeunitId)) {
                    currentCodeunit = testItem;
                    currentIndex = i;
                    break;
                }
            }

            // Mark the next codeunit as pending (don't switch yet - there may be more test results in this batch)
            if (currentIndex >= 0 && currentIndex + 1 < sortedCodeunits.length) {
                pendingCodeunitSwitch = sortedCodeunits[currentIndex + 1];
            }
            return;
        }
    };

    return (data: string) => {
        // Add incoming data to buffer
        buffer += data;

        // Split on newlines
        const lines = buffer.split('\n');

        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || '';

        // Process each complete line
        lines.forEach(line => {
            processLine(line);
        });

        // After processing all lines in this batch, perform pending codeunit switch
        if (pendingCodeunitSwitch) {
            currentCodeunit = pendingCodeunitSwitch;
            const testsToStart = getTestsToStart(currentCodeunit);
            testsToStart.forEach(test => {
                run.started(test);
            });
            pendingCodeunitSwitch = undefined;
        }
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
