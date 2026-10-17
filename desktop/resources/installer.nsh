; Old NSIS uninstallers move the complete installation into
; $PLUGINSDIR\old-install before replacing it. The normal %TEMP% prefix makes
; legacy Android build files AND a bundled Transformers type map exceed
; MAX_PATH. Only change this process's child environment; never global settings.
!macro customInit
  ExpandEnvStrings $0 "%USERPROFILE%"
  StrCpy $0 "$0\.ra-tmp"
  CreateDirectory "$0"
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  IntOp $2 $1 & 0x410
  ${If} $1 == -1
  ${OrIf} $2 != 16
    MessageBox MB_OK|MB_ICONSTOP "无法创建安全的升级临时目录：$0" /SD IDOK
    Abort
  ${EndIf}
  ClearErrors
  GetTempFileName $1 "$0"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "升级临时目录不可写：$0" /SD IDOK
    Abort
  ${EndIf}
  Delete "$1"
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w r0) i.r1'
  ${If} $1 == 0
    MessageBox MB_OK|MB_ICONSTOP "无法设置升级临时目录。请关闭安装器后重试。" /SD IDOK
    Abort
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w r0) i.r1'
  ${If} $1 == 0
    MessageBox MB_OK|MB_ICONSTOP "无法设置升级临时目录。请关闭安装器后重试。" /SD IDOK
    Abort
  ${EndIf}
!macroend

; With a previous per-user installation, the default mode/directory pages can
; both be skipped. Always show a page before a normal launch starts replacing it.
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend
