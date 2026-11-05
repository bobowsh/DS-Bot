; Install for the current user only: the installer skips the page that asks
; "for all users or only for me" and never asks for administrator rights.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The install directory is the one the user picks on the directory page, and the
; page starts at <drive>\LinkBot\app. The program goes there and the data to
; <drive>\LinkBot\data beside it, so the uninstaller leaves the data alone and
; the first run finds its places without asking.
;
; The path is used exactly as it is chosen: electron-builder appends a
; product-name sub-folder to any path that lacks it (assistedInstaller.nsh,
; instFilesPre), but customPageAfterChangeDir replaces that function with one
; that keeps the path as it is. The check for a writable folder runs between the
; directory page and the install (#626).
;
; An earlier installation's folder is the default the page starts at, so an
; upgrade lands where the copy already is.
!macro customInit
  ; The /D= switch wins over everything else: that is how a silent install in
  ; the acceptance run aims the app at a throwaway folder.
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${Else}
    ; The folder is fixed: <drive>\LinkBot\app, with the data at
    ; <drive>\LinkBot\data beside it.
    ;
    ; The registered location of an earlier installation is deliberately NOT read.
    ; It was the one thing that kept an install from ever reaching this folder: a
    ; copy that once landed elsewhere (in a drive's root, or under another
    ; product name) left its path behind, and every later install followed it.
    ; A drive is detected with a wildcard: "D:\" and "D:\." both fail, because a
    ; backslash at the end of the string is an escape and the path never resolves.
    IfFileExists "D:\*" 0 useE
    StrCpy $INSTDIR "D:\LinkBot\app"
    Goto done
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
  ; The directory page is there now: the check below happens on it, and the
  ; install stops here instead, saying which folder is the problem.
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
;
; This also keeps the chosen path as it is: the builder's default instFilesPre
; appends the product name to a path that lacks it, and a path like
; "D:\LinkBot\app" would become "D:\LinkBot\app\LinkBot".
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    Var /GLOBAL dsbCheckTarget

    ; The builder's default instFilesPre appends APP_FILENAME to a path that
    ; lacks the product name. The folder the user picks is the folder the app
    ; goes into, so that suffix is taken off again: what the user chose is what
    ; is installed, with nothing appended.
    !
    ; The builder's function is still called, so its own code stays referenced
    ; (a function nobody calls is a warning the build treats as an error). The
    ; suffix it added is removed by its own length: "\LinkBot" is one backslash
    ; and the product name, so the path is that many characters shorter.
    !define /redef MUI_PAGE_CUSTOMFUNCTION_PRE dsbInstFilesPre

    Function dsbResolveInstDir
      StrCpy $dsbCheckTarget $INSTDIR
    FunctionEnd

    Function dsbInstFilesPre
      ; The path the user chose, before the builder touches it.
      Call dsbResolveInstDir
      ; The builder's own function: it appends the product name to a path that
      ; lacks it.
      Call instFilesPre
      ; Did it append? The path it holds now is the one the user chose, or that
      ; one plus "\LinkBot". The two lengths tell which, and the difference is
      ; how much to take off the end.
      StrLen $2 "$INSTDIR"
      StrLen $3 "$dsbCheckTarget"
      ${If} $2 > $3
        ; It appended: the folder the user chose is that many characters
        ; shorter, so the extra tail goes.
        IntOp $4 $2 - $3
        StrCpy $5 "$INSTDIR" -$4
        StrCpy $INSTDIR $5
      ${EndIf}
    FunctionEnd

    Page custom dsbCheckInstDir

    Function dsbCheckInstDir
      ${if} ${isUpdated}
        Abort
      ${endif}

      ; Probe the same destination that the install page will use.
      Call dsbResolveInstDir

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
