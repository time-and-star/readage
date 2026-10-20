; Transactional, separately compressed offline payloads. This include declares
; macros only; ordinary --dir packages and legacy installers do not expand them.
!ifndef READAGE_INSTALLER_ASSETS_INCLUDED
!define READAGE_INSTALLER_ASSETS_INCLUDED
!include "FileFunc.nsh"

; Use the template's public check hook; NSIS does not permit defining a macro
; inside another macro. Preserve the default process checks before any moves.
!ifdef READAGE_SPLIT_ASSETS
!ifndef BUILD_UNINSTALLER
!ifndef READAGE_ASSET_SKIP_PROCESS_WRAP
  !include "getProcessInfo.nsh"
  Var pid
  !macro customCheckAppRunning
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
    Call readagePreserveAssets
  !macroend
!endif
!endif
!endif

!macro readageAssetHeader
  Var readageAssetsInstallRoot
  Var readageAssetsRegisteredRoot
  Var readageAssetsStash
  Var readageAssetsPreserveChecked
  Var readageAssetsComplete
  Var readageAssetsCommitted
  Var readageAssetsRollbackWarning
  Var readageAssetsCount
  Var readageAssetsWritten
  Var readageAssetsReused
  Var readageAssetsRestoreOk
  Var readageAssetsJournalOk
  Var readageAssetTarget
  Var readageAssetExpected
  Var readageAssetIndex
  Var readageAssetTemporary
  Var readageAssetOldHash
  Var readageAssetNeedsWrite
  Var readageAssetDirectory
  Var readageAssetSavedDirectory

  ; Unlike NSIS GetFullPathName this also normalizes a not-yet-created file.
  Function readageAssetsCanonicalPath
    Exch $0
    Push $1
    Push $2
    System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r2'
    ${If} $2 == 0
    ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
      StrCpy $0 ""
    ${Else}
      StrCpy $0 $1
    ${EndIf}
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  Function readageAssetsPlainDirectory
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

  ; Return the directory, or "". Missing parents may be created, links may not.
  Function readageAssetsEnsureDirectory
    Exch $0
    Push $1
    Push $2
    Push $3
    StrCpy $1 $0
    ${Do}
      ; Capture the OS error in this call: a later System invocation may reset it.
      System::Call 'kernel32::GetFileAttributesW(w r1) i.r2 ?e'
      Pop $3
      ${If} $2 == -1
        ${If} $3 != 2
        ${AndIf} $3 != 3
          StrCpy $0 ""
          Goto readageAssetsEnsureDone
        ${EndIf}
      ${Else}
        IntOp $2 $2 & 0x410
        ${If} $2 != 16
          StrCpy $0 ""
          Goto readageAssetsEnsureDone
        ${EndIf}
      ${EndIf}
      ${GetParent} "$1" $1
    ${LoopUntil} $1 == ""
    ClearErrors
    CreateDirectory "$0"
    ${If} ${Errors}
      StrCpy $0 ""
    ${Else}
      Push $0
      Call readageAssetsPlainDirectory
      Pop $0
    ${EndIf}
    readageAssetsEnsureDone:
    Pop $3
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  ; Only ordinary files with ordinary ancestors are hashable/reusable.
  Function readageAssetsFileHash
    Exch $0
    Push $1
    Push $2
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r2'
    ${If} $2 == -1
      StrCpy $0 ""
      Goto readageAssetsHashDone
    ${EndIf}
    IntOp $2 $2 & 0x410
    ${If} $2 != 0
      StrCpy $0 ""
      Goto readageAssetsHashDone
    ${EndIf}
    ${GetParent} "$0" $1
    Push $1
    Call readageAssetsPlainDirectory
    Pop $1
    ${If} $1 == ""
      StrCpy $0 ""
    ${Else}
      ${StdUtils.HashFile} $0 "SHA2-256" "$0"
      StrLen $1 $0
      ${If} $1 != 64
        StrCpy $0 ""
      ${EndIf}
    ${EndIf}
    readageAssetsHashDone:
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  Function readageAssetsFail
    MessageBox MB_OK|MB_ICONSTOP "离线资源安装未完成。原有资源与学习档案已保留，请保留以下目录并重新运行完整安装包。$\r$\n保留目录：$readageAssetsStash" /SD IDOK
    SetErrorLevel 2
    Abort
  FunctionEnd

  Function readageAssetsCreateStash
    ${If} $readageAssetsStash != ""
      Return
    ${EndIf}
    GetFullPathName $readageAssetsInstallRoot "$INSTDIR"
    StrCpy $0 $readageAssetsInstallRoot 2 1
    StrLen $1 $readageAssetsInstallRoot
    ${If} $0 != ":\"
    ${OrIf} $1 <= 3
      Call readageAssetsFail
    ${EndIf}
    ${GetParent} "$readageAssetsInstallRoot" $0
    Push $0
    Call readageAssetsPlainDirectory
    Pop $0
    ${If} $0 == ""
      Call readageAssetsFail
    ${EndIf}
    ClearErrors
    GetTempFileName $readageAssetsStash "$0"
    ${If} ${Errors}
      Call readageAssetsFail
    ${EndIf}
    Delete "$readageAssetsStash"
    ClearErrors
    CreateDirectory "$readageAssetsStash"
    ${If} ${Errors}
      Call readageAssetsFail
    ${EndIf}
    Push $readageAssetsStash
    Call readageAssetsPlainDirectory
    Pop $0
    ${If} $0 == ""
      Call readageAssetsFail
    ${EndIf}
    StrCpy $readageAssetsCount 0
    StrCpy $readageAssetsWritten 0
    StrCpy $readageAssetsReused 0
    ClearErrors
    WriteINIStr "$readageAssetsStash\journal.ini" "transaction" "format" "readage-assets-v1"
    WriteINIStr "$readageAssetsStash\journal.ini" "transaction" "root" "$readageAssetsInstallRoot"
    WriteINIStr "$readageAssetsStash\journal.ini" "transaction" "count" "0"
    ${If} ${Errors}
      Call readageAssetsFail
    ${EndIf}
  FunctionEnd

  Function readageAssetsCheckJournal
    Push $0
    Push $1
    StrCpy $readageAssetsJournalOk "0"
    Push $readageAssetsStash
    Call readageAssetsPlainDirectory
    Pop $0
    ${If} $0 == ""
      Goto readageAssetsJournalDone
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w "$readageAssetsStash\journal.ini") i.r0'
    ${If} $0 == -1
      Goto readageAssetsJournalDone
    ${EndIf}
    IntOp $0 $0 & 0x410
    ${If} $0 != 0
      Goto readageAssetsJournalDone
    ${EndIf}
    ReadINIStr $0 "$readageAssetsStash\journal.ini" "transaction" "format"
    ReadINIStr $1 "$readageAssetsStash\journal.ini" "transaction" "root"
    ${If} $0 == "readage-assets-v1"
    ${AndIf} $1 == $readageAssetsInstallRoot
      StrCpy $readageAssetsJournalOk "1"
    ${EndIf}
    readageAssetsJournalDone:
    Pop $1
    Pop $0
  FunctionEnd

  Function readagePreserveAssets
    ${If} $readageAssetsPreserveChecked == "1"
      Return
    ${EndIf}
    StrCpy $readageAssetsPreserveChecked "1"
    !insertmacro readageReadLegacyRoot SHELL_CONTEXT $readageAssetsRegisteredRoot
    StrCpy $0 $readageAssetsRegisteredRoot
    ${If} $0 == ""
      Return
    ${EndIf}
    GetFullPathName $0 "$0"
    GetFullPathName $1 "$INSTDIR"
    ${If} $0 != $1
      Return ; Directory changes use the complete embedded offline payload.
    ${EndIf}
    StrCpy $2 $0 2 1
    ${If} $2 != ":\"
      Return
    ${EndIf}
    IfFileExists "$0\readge.exe" 0 readagePreserveDone
    IfFileExists "$0\Uninstall readge.exe" 0 readagePreserveDone
    Push $0
    Call readageAssetsPlainDirectory
    Pop $2
    ${If} $2 == ""
      Call readageAssetsFail
    ${EndIf}
    Call readageAssetsCreateStash
    !insertmacro readagePreserveAssetDirectory "resources\offline-resources" "offline"
    !insertmacro readagePreserveAssetDirectory "resources\released-dictionaries" "dictionaries"
    readagePreserveDone:
  FunctionEnd

  Function readageAssetsRestoreOneDirectory
    System::Call 'kernel32::GetFileAttributesW(w "$readageAssetSavedDirectory") i.r0'
    ${If} $0 == -1
      Return
    ${EndIf}
    Push $readageAssetSavedDirectory
    Call readageAssetsPlainDirectory
    Pop $0
    ${If} $0 == ""
      StrCpy $readageAssetsRestoreOk "0"
      Return
    ${EndIf}
    ${GetParent} "$readageAssetDirectory" $0
    Push $0
    Call readageAssetsEnsureDirectory
    Pop $0
    ${If} $0 == ""
      StrCpy $readageAssetsRestoreOk "0"
      Return
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w "$readageAssetDirectory") i.r0'
    ${If} $0 != -1
      Push $readageAssetDirectory
      Call readageAssetsPlainDirectory
      Pop $0
      ${If} $0 == ""
        StrCpy $readageAssetsRestoreOk "0"
        Return
      ${EndIf}
      ClearErrors
      RMDir "$readageAssetDirectory" ; Empty directories only; never overwrite.
      ${If} ${Errors}
        StrCpy $readageAssetsRestoreOk "0"
        Return
      ${EndIf}
    ${EndIf}
    ClearErrors
    Rename "$readageAssetSavedDirectory" "$readageAssetDirectory"
    ${If} ${Errors}
      StrCpy $readageAssetsRestoreOk "0"
    ${EndIf}
  FunctionEnd

  Function readageAssetsRestoreDirectories
    StrCpy $readageAssetsRestoreOk "1"
    ${If} $readageAssetsStash == ""
      Return
    ${EndIf}
    StrCpy $readageAssetDirectory "$readageAssetsInstallRoot\resources\offline-resources"
    StrCpy $readageAssetSavedDirectory "$readageAssetsStash\offline"
    Call readageAssetsRestoreOneDirectory
    StrCpy $readageAssetDirectory "$readageAssetsInstallRoot\resources\released-dictionaries"
    StrCpy $readageAssetSavedDirectory "$readageAssetsStash\dictionaries"
    Call readageAssetsRestoreOneDirectory
  FunctionEnd

  ; A journal can only refer to files in the two immutable resource roots.
  Function readageAssetsCheckTarget
    Push $0
    Push $1
    Push $readageAssetTarget
    Call readageAssetsCanonicalPath
    Pop $readageAssetTarget
    StrLen $0 "$readageAssetsInstallRoot\resources\offline-resources\"
    StrCpy $1 $readageAssetTarget $0
    ${If} $1 == "$readageAssetsInstallRoot\resources\offline-resources\"
      Goto readageAssetsTargetDone
    ${EndIf}
    StrLen $0 "$readageAssetsInstallRoot\resources\released-dictionaries\"
    StrCpy $1 $readageAssetTarget $0
    ${If} $1 != "$readageAssetsInstallRoot\resources\released-dictionaries\"
      StrCpy $readageAssetTarget ""
    ${EndIf}
    readageAssetsTargetDone:
    Pop $1
    Pop $0
  FunctionEnd

  Function readageAssetsPrepareFile
    Call readageAssetsCreateStash
    Call readageAssetsCheckJournal
    ${If} $readageAssetsJournalOk != "1"
      Call readageAssetsFail
    ${EndIf}
    Call readageAssetsCheckTarget
    ${If} $readageAssetTarget == ""
    ${OrIf} $readageAssetIndex != $readageAssetsCount
      Call readageAssetsFail
    ${EndIf}
    ${GetParent} "$readageAssetTarget" $0
    Push $0
    Call readageAssetsEnsureDirectory
    Pop $0
    ${If} $0 == ""
      Call readageAssetsFail
    ${EndIf}
    StrCpy $readageAssetNeedsWrite "1"
    StrCpy $readageAssetOldHash ""
    Push $readageAssetTarget
    Call readageAssetsFileHash
    Pop $readageAssetOldHash
    ${If} $readageAssetOldHash == $readageAssetExpected
      StrCpy $readageAssetNeedsWrite "0"
      IntOp $readageAssetsReused $readageAssetsReused + 1
      IntOp $readageAssetsCount $readageAssetsCount + 1
      Return ; No per-file journal writes for a verified, unchanged payload.
    ${Else}
      System::Call 'kernel32::GetFileAttributesW(w "$readageAssetTarget") i.r0'
      ${If} $0 != -1
      ${AndIf} $readageAssetOldHash == ""
        Call readageAssetsFail
      ${EndIf}
    ${EndIf}
    IntOp $readageAssetsCount $readageAssetsCount + 1
    ClearErrors
    WriteINIStr "$readageAssetsStash\journal.ini" "transaction" "count" "$readageAssetsCount"
    WriteINIStr "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "target" "$readageAssetTarget"
    WriteINIStr "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "digest" "$readageAssetExpected"
    WriteINIStr "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "oldDigest" "$readageAssetOldHash"
    WriteINIStr "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "changed" "$readageAssetNeedsWrite"
    ${If} ${Errors}
      Call readageAssetsFail
    ${EndIf}
    ${If} $readageAssetNeedsWrite == "1"
      ${GetParent} "$readageAssetTarget" $0
      ClearErrors
      GetTempFileName $readageAssetTemporary "$0"
      ${If} ${Errors}
        Call readageAssetsFail
      ${EndIf}
      WriteINIStr "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "temporary" "$readageAssetTemporary"
      ${If} ${Errors}
        Call readageAssetsFail
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function readageAssetsFinishFile
    Push $readageAssetTemporary
    Call readageAssetsFileHash
    Pop $0
    ${If} $0 != $readageAssetExpected
      Call readageAssetsFail
    ${EndIf}
    ${If} $readageAssetOldHash != ""
      Push $readageAssetTarget
      Call readageAssetsFileHash
      Pop $0
      ${If} $0 != $readageAssetOldHash
        Call readageAssetsFail
      ${EndIf}
      ClearErrors
      Rename "$readageAssetTarget" "$readageAssetsStash\old-$readageAssetIndex"
      ${If} ${Errors}
        Call readageAssetsFail
      ${EndIf}
    ${EndIf}
    ClearErrors
    Rename "$readageAssetTemporary" "$readageAssetTarget"
    ${If} ${Errors}
      Call readageAssetsFail
    ${EndIf}
    IntOp $readageAssetsWritten $readageAssetsWritten + 1
  FunctionEnd

  Function readageAssetsPayloadComplete
    StrCpy $readageAssetsComplete "1"
  FunctionEnd

  Function readageAssetsRollback
    ${If} $readageAssetsCommitted == "1"
    ${OrIf} $readageAssetsStash == ""
      Return
    ${EndIf}
    Push $0
    Push $1
    Push $2
    Push $3
    StrCpy $3 "0"
    Push $readageAssetsStash
    Call readageAssetsPlainDirectory
    Pop $0
    ${If} $0 == ""
      StrCpy $3 "1"
      Goto readageAssetsRollbackDone
    ${EndIf}
    Call readageAssetsCheckJournal
    ${If} $readageAssetsJournalOk != "1"
      StrCpy $3 "1"
      Goto readageAssetsRollbackDone
    ${EndIf}
    StrCpy $readageAssetIndex $readageAssetsCount
    ${DoWhile} $readageAssetIndex > 0
      IntOp $readageAssetIndex $readageAssetIndex - 1
      ReadINIStr $0 "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "changed"
      ${If} $0 != "1"
        ${Continue}
      ${EndIf}
      ReadINIStr $readageAssetTarget "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "target"
      ReadINIStr $readageAssetExpected "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "digest"
      ReadINIStr $readageAssetOldHash "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "oldDigest"
      Call readageAssetsCheckTarget
      ${If} $readageAssetTarget == ""
        StrCpy $3 "1"
        ${Continue}
      ${EndIf}
      Push $readageAssetTarget
      Call readageAssetsFileHash
      Pop $0
      ${If} $0 == $readageAssetExpected
        ; Also covers a failure persisting the installed flag after Rename.
        ClearErrors
        Delete "$readageAssetTarget"
        ${If} ${Errors}
          StrCpy $3 "1"
          ${Continue}
        ${EndIf}
      ${ElseIf} $0 != ""
      ${AndIf} $0 != $readageAssetOldHash
        StrCpy $3 "1" ; Unknown replacement belongs to someone else.
        ${Continue}
      ${ElseIf} $0 == ""
        System::Call 'kernel32::GetFileAttributesW(w "$readageAssetTarget") i.r1'
        ${If} $1 != -1
          StrCpy $3 "1" ; A directory/link is not an absent original file.
          ${Continue}
        ${EndIf}
      ${EndIf}
      Push "$readageAssetsStash\old-$readageAssetIndex"
      Call readageAssetsFileHash
      Pop $2
      ${If} $readageAssetOldHash != ""
      ${AndIf} $2 == $readageAssetOldHash
        System::Call 'kernel32::GetFileAttributesW(w "$readageAssetTarget") i.r0'
        ${If} $0 == -1
          ClearErrors
          Rename "$readageAssetsStash\old-$readageAssetIndex" "$readageAssetTarget"
          ${If} ${Errors}
            StrCpy $3 "1"
          ${EndIf}
        ${Else}
          ; No backup was moved if preparation failed before replacement.
          Push $readageAssetTarget
          Call readageAssetsFileHash
          Pop $0
          ${If} $0 != $readageAssetOldHash
            StrCpy $3 "1"
          ${EndIf}
        ${EndIf}
      ${Else}
        ${If} $2 != ""
          StrCpy $3 "1"
        ${ElseIf} $readageAssetOldHash != ""
          Push $readageAssetTarget
          Call readageAssetsFileHash
          Pop $0
          ${If} $0 != $readageAssetOldHash
            StrCpy $3 "1" ; An unexpectedly missing backup is not success.
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ReadINIStr $readageAssetTemporary "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "temporary"
      ${If} $readageAssetTemporary != ""
        Push $readageAssetTemporary
        Call readageAssetsCanonicalPath
        Pop $readageAssetTemporary
        ${GetParent} "$readageAssetTemporary" $0
        ${GetParent} "$readageAssetTarget" $1
        ${If} $0 != $1
          StrCpy $3 "1"
          ${Continue}
        ${EndIf}
        Push $readageAssetTemporary
        Call readageAssetsFileHash
        Pop $0
        ${If} $0 == $readageAssetExpected
          Delete "$readageAssetTemporary"
        ${EndIf}
      ${EndIf}
      ; Repeated GUI/failure callbacks must not delete an already restored file.
      Push $readageAssetTarget
      Call readageAssetsFileHash
      Pop $0
      ${If} $0 == $readageAssetOldHash
        WriteINIStr "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "changed" "0"
      ${EndIf}
    ${Loop}
    Call readageAssetsRestoreDirectories
    ${If} $readageAssetsRestoreOk != "1"
      StrCpy $3 "1"
    ${EndIf}
    readageAssetsRollbackDone:
    ${If} $3 == "1"
    ${AndIf} $readageAssetsRollbackWarning != "1"
      StrCpy $readageAssetsRollbackWarning "1"
      MessageBox MB_OK|MB_ICONEXCLAMATION "部分旧资源未能自动还原，已保留以下目录；没有覆盖冲突文件或学习档案：$\r$\n$readageAssetsStash" /SD IDOK
    ${EndIf}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  Function readageAssetsCommit
    ${If} $readageAssetsComplete != "1"
    ${OrIf} $readageAssetsCommitted == "1"
      Return
    ${EndIf}
    StrCpy $readageAssetsCommitted "1"
    ${If} $readageAssetsStash == ""
      Return
    ${EndIf}
    Push $0
    Push $1
    Push $2
    Push $readageAssetsStash
    Call readageAssetsPlainDirectory
    Pop $0
    ${If} $0 == ""
      Goto readageAssetsCommitDone
    ${EndIf}
    Call readageAssetsCheckJournal
    ${If} $readageAssetsJournalOk != "1"
      Goto readageAssetsCommitDone
    ${EndIf}
    StrCpy $2 "1"
    StrCpy $readageAssetIndex "0"
    ${DoWhile} $readageAssetIndex < $readageAssetsCount
      ReadINIStr $0 "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "changed"
      ${If} $0 != "1"
        IntOp $readageAssetIndex $readageAssetIndex + 1
        ${Continue}
      ${EndIf}
      ReadINIStr $1 "$readageAssetsStash\journal.ini" "file-$readageAssetIndex" "oldDigest"
      Push "$readageAssetsStash\old-$readageAssetIndex"
      Call readageAssetsFileHash
      Pop $0
      ${If} $0 != ""
        ${If} $0 == $1
          Delete "$readageAssetsStash\old-$readageAssetIndex"
        ${Else}
          StrCpy $2 "0"
        ${EndIf}
      ${Else}
        System::Call 'kernel32::GetFileAttributesW(w "$readageAssetsStash\old-$readageAssetIndex") i.r0'
        ${If} $0 != -1
          StrCpy $2 "0"
        ${EndIf}
      ${EndIf}
      IntOp $readageAssetIndex $readageAssetIndex + 1
    ${Loop}
    ${If} $2 == "1"
      Delete "$readageAssetsStash\journal.ini"
      RMDir "$readageAssetsStash" ; No recursive cleanup of unknown files.
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "安装已完成，部分旧资源备份已保留，未删除不匹配的文件：$\r$\n$readageAssetsStash" /SD IDOK
    ${EndIf}
    readageAssetsCommitDone:
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

!macroend

!macro readagePreserveAssetDirectory RELATIVE SAVED
  StrCpy $readageAssetDirectory "$readageAssetsInstallRoot\${RELATIVE}"
  System::Call 'kernel32::GetFileAttributesW(w "$readageAssetDirectory") i.r0'
  ${If} $0 != -1
    Push $readageAssetDirectory
    Call readageAssetsPlainDirectory
    Pop $0
    ${If} $0 == ""
      Call readageAssetsFail
    ${EndIf}
    ClearErrors
    Rename "$readageAssetDirectory" "$readageAssetsStash\${SAVED}"
    ${If} ${Errors}
      Call readageAssetsFail
    ${EndIf}
  ${EndIf}
!macroend

!macro readageRestoreAssets
  Call readageAssetsCreateStash
  Call readageAssetsRestoreDirectories
  ${If} $readageAssetsRestoreOk != "1"
    Call readageAssetsFail
  ${EndIf}
!macroend

!macro readageInstallAsset RELATIVE SOURCE DIGEST INDEX
  StrCpy $readageAssetTarget "$INSTDIR\${RELATIVE}"
  StrCpy $readageAssetExpected "${DIGEST}"
  StrCpy $readageAssetIndex "${INDEX}"
  Call readageAssetsPrepareFile
  ${If} $readageAssetNeedsWrite == "1"
    ClearErrors
    File "/oname=$readageAssetTemporary" "${SOURCE}"
    ${If} ${Errors}
      Call readageAssetsFail
    ${EndIf}
    Call readageAssetsFinishFile
  ${EndIf}
!macroend
!endif
