; Old NSIS uninstallers move the complete installation into
; $PLUGINSDIR\old-install before replacing it. The normal %TEMP% prefix makes
; legacy Android build files AND a bundled Transformers type map exceed
; MAX_PATH. Only change this process's child environment; never global settings.
!include "FileFunc.nsh"
!include "${__FILEDIR__}\installer-assets.nsh"

!macro readageReadLegacyRoot ROOT_KEY OUTPUT
  ReadRegStr ${OUTPUT} ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} ${OUTPUT} == ""
    Push $0
    ReadRegStr $0 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" UninstallString
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $0 == ""
        ReadRegStr $0 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
    !endif
    Push $0
    Call readageRootFromUninstallString
    Pop ${OUTPUT}
    Pop $0
  ${EndIf}
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
  Var readageLegacyRoot
  Var readageLegacyQuarantine
  Var readageLegacyUserRoot
  Var readageLegacyUserQuarantine

  ; Match electron-builder's fallback when the internal installation key is
  ; absent. Only accept its quoted, fixed uninstaller filename.
  Function readageRootFromUninstallString
    Exch $0
    Push $1
    Push $2
    StrCpy $1 $0 1
    ${If} $1 != '"'
      StrCpy $0 ""
      Goto readageRootParsed
    ${EndIf}
    StrCpy $0 $0 "" 1
    StrCpy $2 0
    ${Do}
      StrCpy $1 $0 1 $2
      ${If} $1 == ""
        StrCpy $0 ""
        Goto readageRootParsed
      ${EndIf}
      ${If} $1 == '"'
        ${Break}
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
    StrCpy $0 $0 $2
    ${GetFileName} "$0" $1
    ${If} $1 == "Uninstall readge.exe"
      ${GetParent} "$0" $0
    ${Else}
      StrCpy $0 ""
    ${EndIf}
    readageRootParsed:
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  ; Validate every ancestor, including the installation root. Never traverse a
  ; junction/symlink while repairing an old package. $0 is a canonical path.
  Function readageCheckPlainDirectory
    Exch $0
    Push $1
    Push $2
    StrCpy $1 $0
    ${Do}
      System::Call 'kernel32::GetFileAttributesW(w r1) i.r2'
      ${If} $2 == -1
        StrCpy $0 ""
        ${Break}
      ${EndIf}
      IntOp $2 $2 & 0x410
      ${If} $2 != 16
        StrCpy $0 ""
        ${Break}
      ${EndIf}
      ${GetParent} "$1" $1
    ${LoopUntil} $1 == ""
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  ; Move only the accidentally bundled Android dependency. A whole-directory
  ; rename never visits its 262-character children. Keeping it inside the old
  ; installation makes both the old uninstaller's rollback and cleanup work.
  ; Input: registered installation root. Output: unique quarantine path or "".
  Function readageQuarantineLegacyAndroid
    Exch $0
    Push $1
    Push $2
    Push $3
    StrCpy $3 $0 2 1
    ${If} $0 == ""
      Goto readageLegacyAbsent
    ${EndIf}
    ${If} $3 != ":\"
      Goto readageLegacyUnsafe
    ${EndIf}
    GetFullPathName $0 "$0"
    StrLen $3 $0
    ${If} $3 <= 3
      Goto readageLegacyUnsafe
    ${EndIf}
    StrCpy $1 "$0\resources\app.asar.unpacked\node_modules\@capacitor\android"
    System::Call 'kernel32::GetFileAttributesW(w r1) i.r2'
    ${If} $2 == -1
      Goto readageLegacyAbsent
    ${EndIf}
    ; Require a real legacy ReadAge installation, not an arbitrary directory.
    IfFileExists "$0\readge.exe" 0 readageLegacyUnsafe
    IfFileExists "$0\Uninstall readge.exe" 0 readageLegacyUnsafe
    Push $1
    Call readageCheckPlainDirectory
    Pop $2
    ${If} $2 == ""
      Goto readageLegacyUnsafe
    ${EndIf}
    StrCpy $3 0
    ${Do}
      StrCpy $1 "$0\.ra-android-$3"
      System::Call 'kernel32::GetFileAttributesW(w r1) i.r2'
      ${If} $2 == -1
        ${Break}
      ${EndIf}
      IntOp $3 $3 + 1
      ${If} $3 > 999
        Goto readageLegacyUnsafe
      ${EndIf}
    ${Loop}
    ClearErrors
    Rename "$0\resources\app.asar.unpacked\node_modules\@capacitor\android" "$1"
    ${If} ${Errors}
      Goto readageLegacyUnsafe
    ${EndIf}
    StrCpy $0 $1
    Goto readageLegacyDone
    readageLegacyAbsent:
      StrCpy $0 ""
      Goto readageLegacyDone
    readageLegacyUnsafe:
      MessageBox MB_OK|MB_ICONSTOP "无法安全整理旧版安装文件。请保留学习档案，并关闭 ReadAge 后重试。$\r$\n安装目录：$0" /SD IDOK
      SetErrorLevel 2
      Quit
    readageLegacyDone:
    Pop $3
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  Function readagePrepareLegacyUpgrade
    ${If} $readageLegacyQuarantine == ""
      !insertmacro readageReadLegacyRoot SHELL_CONTEXT $readageLegacyRoot
      Push $readageLegacyRoot
      Call readageQuarantineLegacyAndroid
      Pop $readageLegacyQuarantine
    ${EndIf}
    ; An all-users upgrade also removes a previous current-user installation.
    ${If} $installMode == "all"
    ${AndIf} $readageLegacyUserQuarantine == ""
      !insertmacro readageReadLegacyRoot HKCU $readageLegacyUserRoot
      ${If} $readageLegacyUserRoot != $readageLegacyRoot
        Push $readageLegacyUserRoot
        Call readageQuarantineLegacyAndroid
        Pop $readageLegacyUserQuarantine
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function readageRestoreLegacyDirectory
    Exch $0
    Push $1
    Push $2
    ${If} $0 == ""
      Goto readageRestoreDone
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r2'
    ${If} $2 == -1
      Goto readageRestoreDone
    ${EndIf}
    Push $0
    Call readageCheckPlainDirectory
    Pop $2
    ${If} $2 == ""
      Goto readageRestoreFailed
    ${EndIf}
    ${GetParent} "$0" $1
    StrCpy $1 "$1\resources\app.asar.unpacked\node_modules\@capacitor"
    Push $1
    Call readageCheckPlainDirectory
    Pop $2
    ${If} $2 == ""
      Goto readageRestoreFailed
    ${EndIf}
    ClearErrors
    Rename "$0" "$1\android"
    ${IfNot} ${Errors}
      Goto readageRestoreDone
    ${EndIf}
    readageRestoreFailed:
      MessageBox MB_OK|MB_ICONEXCLAMATION "旧版组件已保留在以下目录，未覆盖已有文件：$\r$\n$0" /SD IDOK
    readageRestoreDone:
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  Function readageRestoreLegacyUpgrade
    Push $readageLegacyQuarantine
    Call readageRestoreLegacyDirectory
    Push $readageLegacyUserQuarantine
    Call readageRestoreLegacyDirectory
  FunctionEnd

  Function .onGUIEnd
!ifdef READAGE_SPLIT_ASSETS
    Call readageAssetsRollback
!endif
    Call readageRestoreLegacyUpgrade
  FunctionEnd

  Function .onInstFailed
!ifdef READAGE_SPLIT_ASSETS
    Call readageAssetsRollback
!endif
    Call readageRestoreLegacyUpgrade
  FunctionEnd

  Function readagePrepareLegacyUpgradePage
    Call readagePrepareLegacyUpgrade
    Abort ; Skip this invisible page and continue to installation.
  FunctionEnd
!ifdef READAGE_SPLIT_ASSETS
  !insertmacro readageAssetHeader
  Function .onInstSuccess
    Call readageAssetsCommit
  FunctionEnd
!endif
!endif
!macroend

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
  ; Silent upgrades have no confirmation page. A machine-wide outer process
  ; must wait for electron-builder's elevated inner process before moving files.
  ${If} ${Silent}
    ${If} $installMode != "all"
      Call readagePrepareLegacyUpgrade
    ${ElseIf} ${UAC_IsAdmin}
      Call readagePrepareLegacyUpgrade
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  ; This callback runs only after the user advances through the welcome / mode /
  ; directory pages. Merely opening or cancelling the wizard changes no files.
  Page custom readagePrepareLegacyUpgradePage
!macroend

; With a previous per-user installation, the default mode/directory pages can
; both be skipped. Always show a page before a normal launch starts replacing it.
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend
