Option Explicit
On Error Resume Next

Dim fso, shell, automacaoDir, watcherScript, localBootstrap, attempts, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Fail-safe silencioso: tenta delegar para o bootstrapper local em C:\ se disponivel
localBootstrap = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\ObsidianAutoOrganizer\local_bootstrap.vbs")
If fso.FileExists(localBootstrap) Then
  shell.Run "wscript.exe //B """ & localBootstrap & """", 0, False
  WScript.Quit 0
End If

automacaoDir = fso.GetParentFolderName(WScript.ScriptFullName)
watcherScript = automacaoDir & "\dist\watcher.js"

attempts = 0
Do While Not fso.FileExists(watcherScript)
  attempts = attempts + 1
  If attempts >= 30 Then
    WScript.Quit 0
  End If
  WScript.Sleep 2000
Loop

shell.CurrentDirectory = automacaoDir
cmd = "node.exe """ & watcherScript & """"
shell.Run cmd, 0, False
