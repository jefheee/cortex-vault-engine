Option Explicit
On Error Resume Next

Dim fso, shell, targetDir, targetScript, attempts, maxAttempts, cmd
Dim wmi, procs, proc
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

targetDir = "G:\Meu Drive\Obsidian\.automacao"
targetScript = targetDir & "\dist\watcher.js"
maxAttempts = 60 ' 60 x 3s = 180s (3 minutos aguardando montagem do Google Drive G:\)

attempts = 0
Do While Not fso.FileExists(targetScript)
  attempts = attempts + 1
  If attempts >= maxAttempts Then
    WScript.Quit 0
  End If
  WScript.Sleep 3000
Loop

' Evita segunda chamada se watcher.js ja estiver em execucao
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number = 0 Then
  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'node.exe' AND CommandLine LIKE '%watcher.js%'")
  For Each proc In procs
    WScript.Quit 0
  Next
End If
Err.Clear

shell.CurrentDirectory = targetDir
cmd = "node.exe """ & targetScript & """"
shell.Run cmd, 0, False
