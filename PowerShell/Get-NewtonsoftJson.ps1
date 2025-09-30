function Get-NewtonsoftJsonPath {
    $dlls = Get-ChildItem -Path "$(Get-TestClientPath)\Newtonsoft.Json*\lib\net6.0\Newtonsoft.Json.dll"
    if ($dlls.Count -eq 0) {
        nuget install Newtonsoft.Json -OutputDirectory "$(Get-TestClientPath)" | Out-Null
        $dlls = Get-ChildItem -Path "$(Get-TestClientPath)\Newtonsoft.Json*\lib\net6.0\Newtonsoft.Json.dll"
    }

    if ($dlls.Count -eq 0) {
        throw "Could not find Newtonsoft.Json.dll"
    }

    ($dlls | Select-Object -First 1).FullName
}

Export-ModuleMember -Function Get-NewtonsoftJsonPath