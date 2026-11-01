; Install for the current user only: the installer skips the page that asks
; "for all users or only for me" and never asks for administrator rights.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The install directory is fixed: the program goes to <drive>\LinkBot\app and the
; data to <drive>\LinkBot\data beside it, so the uninstaller leaves the data alone
; and the first run finds its places without asking. The drive is D when the machine
; has one and E otherwise; the user does not choose it.
;
; electron-builder appends a product-name sub-folder to any path that does not
; already contain it (assistedInstaller.nsh, instFilesPre). That whole block sits
; inside `!ifdef allowToChangeInstallationDirectory`, so with the directory page
; turned off the path is used exactly as it is set here.
;
; The order is: an earlier installation keeps its own drive, then the /D= switch
; overrides it (how the silent install in the acceptance run sets the path), and
; only a fresh install picks the drive.
!macro customInit
  ; An earlier installation lives where it was put: keep it there.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${Else}
    ; The /D= switch wins over the chosen drive, so a test install can go anywhere.
    !insertmacro GetDParameter $R0
    ${If} $R0 != ""
      StrCpy $INSTDIR $R0
    ${Else}
      ; A drive is detected with a wildcard: "D:\" and "D:\." both fail, because a
      ; backslash at the end of the string is an escape and the path never resolves.
      IfFileExists "D:\*" 0 useE
      StrCpy $INSTDIR "D:\LinkBot\app"
      Goto done
    ${EndIf}
    useE:
    ; No D drive: the next one the user asked for is E.
    IfFileExists "E:\*" 0 noDrive
    StrCpy $INSTDIR "E:\LinkBot\app"
    Goto done
    noDrive:
    ; Neither drive: the program folder of the current user is the last resort.
    StrCpy $INSTDIR "$LocalAppData\Programs\LinkBot\app"
    done:
  ${EndIf}

  ; The installer never asks for administrator rights, so a folder the user cannot
  ; write to only fails halfway through the install, with a misleading error.
  ; The directory is fixed now, so there is no directory page to go back to: the
  ; install stops here instead, and says which folder is the problem.
  ClearErrors
  CreateDirectory "$INSTDIR"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Cannot create $INSTDIR. Choose a folder you can write to."
    Abort
  ${EndIf}
  ; A folder that holds files is an upgrade; it must also allow deleting them.
  ClearErrors
  GetTempFileName $R1 "$INSTDIR"
  ${If} ${Errors}
  ${OrIf} $R1 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Cannot write to $INSTDIR. Choose a folder you can write to."
    Abort
  ${EndIf}
  ClearErrors
  Delete "$R1"
!macroend

; The LANG_* symbols exist only after addLangs, which runs just before this
; hook; a LangString for a language the build does not load would create a
; phantom language table (makensis warning 6040, treated as error).
!macro customHeader
  !ifdef LANG_SIMPCHINESE
    LangString dsbInstDirNotWritable ${LANG_SIMPCHINESE} "无法写入「$dsbCheckTarget」。请换一个位置。"
  !endif
  !ifdef LANG_ENGLISH
    LangString dsbInstDirNotWritable ${LANG_ENGLISH} "Cannot write to $dsbCheckTarget. Choose another location."
  !endif
!macroend

; #626: the installer never asks for administrator rights, so a folder the user
; cannot write to only fails halfway through the install, with a misleading
; error. A content-less page between the directory page and the install checks
; that the chosen folder can be created and written to, and sends the user back
; to the directory page when it cannot.
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    Var /GLOBAL dsbCheckTarget

    Page custom dsbCheckInstDir

    Function dsbCheckInstDir
      ${if} ${isUpdated}
        Abort
      ${endif}

      ; instFilesPre appends ${APP_FILENAME} to $INSTDIR only after this page,
      ; so the same rule is applied here on a copy and $INSTDIR stays untouched.
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${if} $0 == ""
        StrCpy $dsbCheckTarget "$INSTDIR\${APP_FILENAME}"
      ${else}
        StrCpy $dsbCheckTarget $INSTDIR
      ${endif}

      ; $R1: the nearest ancestor that exists. Folders this check creates are
      ; removed again below, and only as far up as this ancestor.
      StrCpy $R1 $dsbCheckTarget
      ${Do}
        ${If} ${FileExists} "$R1"
          ${ExitDo}
        ${EndIf}
        ${StdUtils.GetParentPath} $R2 "$R1"
        ${If} $R2 == ""
        ${OrIf} $R2 == $R1
          ${ExitDo}
        ${EndIf}
        StrCpy $R1 $R2
      ${Loop}

      ; what the install does right after this: create the folder, write files
      StrCpy $R3 0
      ${IfNot} ${FileExists} "$dsbCheckTarget"
        ClearErrors
        CreateDirectory "$dsbCheckTarget"
        ${If} ${Errors}
          StrCpy $R3 1
        ${EndIf}
      ${EndIf}
      ${If} $R3 == 0
        ClearErrors
        GetTempFileName $R2 "$dsbCheckTarget"
        ${If} ${Errors}
        ${OrIf} $R2 == ""
          StrCpy $R3 1
        ${Else}
          ; updates replace files, so a folder must also allow deleting them
          ClearErrors
          Delete "$R2"
          ${If} ${Errors}
            StrCpy $R3 1
          ${EndIf}
        ${EndIf}
      ${EndIf}

      StrCpy $R4 $dsbCheckTarget
      ${DoWhile} $R4 != $R1
        RMDir "$R4"
        ${StdUtils.GetParentPath} $R2 "$R4"
        ${If} $R2 == ""
        ${OrIf} $R2 == $R4
          ${ExitDo}
        ${EndIf}
        StrCpy $R4 $R2
      ${Loop}

      ${If} $R3 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(dsbInstDirNotWritable)"
        SendMessage $HWNDPARENT 0x408 -1 0
      ${EndIf}
      Abort
    FunctionEnd
  !endif
!macroend
