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
; The directory page starts at <drive>\LinkBot\app, which customInit works out and writes
; back to the registry: NSIS's InstallDir page reads the previous install's registered
; location as its starting value, so without the write-back it would start at wherever an
; old copy once lived. The path is used exactly as it is chosen: electron-builder appends a
; product-name sub-folder to any path that lacks it (assistedInstaller.nsh,
; instFilesPre), but customPageAfterChangeDir replaces that function with one
; that keeps the path as it is. The check for a writable folder runs between the
; directory page and the install (#626).
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
    ; The registered location of an earlier installation is deliberately NOT read: a copy
    ; that once landed elsewhere (in a drive's root, or under another product name) left
    ; its path behind, and every later install followed it. But the InstallDir page does
    ; read that registry value as its starting point, so the folder worked out here is
    ; written back over it — the page then starts where this installer means to install.
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
    WriteRegStr HKCU "Software\32c46dfc-ed78-5d41-85a4-a3c7f083f2e0" "InstallLocation" "$INSTDIR"
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
    ;
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
      ; how much to take off the end. Both count characters, so a path with
      ; Chinese in it is cut at the same place it was measured.
      StrLen $2 "$INSTDIR"
      StrLen $3 "$dsbCheckTarget"
      ${If} $2 > $3
        IntOp $4 $2 - $3
        ; A cut of nothing would empty the path, and StrCpy reads a cut of zero
        ; that way, so it is only done when there is something to take off.
        ${If} $4 > 0
          StrCpy $5 "$INSTDIR" -$4
          StrCpy $INSTDIR $5
        ${EndIf}
      ${EndIf}
    FunctionEnd

    Page custom dsbCheckInstDir

    Function dsbCheckInstDir
      ${if} ${isUpdated}
        Abort
      ${endif}

      ; Probe the same destination that the install page will use.
      Call dsbResolveInstDir

      ; A drive's root is not a place for one app. The installer asks whether the app is
      ; running by looking at the paths of the processes that start with the install folder,
      ; so a root would make it every process on the drive, and the install would stop with
      ; "cannot be closed" for something it cannot close.
      ${StdUtils.GetParentPath} $R5 "$dsbCheckTarget"
      ${If} $R5 == ""
      ${OrIf} $R5 == "$dsbCheckTarget"
        MessageBox MB_OK|MB_ICONEXCLAMATION "Choose a folder for the app, not the drive's root."
        Abort
      ${EndIf}

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

; The factory plugins (a DSH home tree: profiles/ds-bot/node_modules/<plugin>), the skills
; repository and the factory list travel in <INSTDIR>\data (extraFiles). The data home of an
; install is the folder beside the program, so the installer moves them there after the install.
;
; Only the two whitelisted folders are written, and inside profiles only the names on the
; factory list: the data home holds the user's own data (bot/, profiles/, sessions/ ...), and
; a plugin the user installed themselves must not be replaced or removed by an upgrade.
;
; The factory skills are the package's own copies: an installed one is replaced, but one backup
; of the replaced content is kept (<data>\skills\<slug>.bak, the most recent previous content
; only). A skill the package does not carry is the user's own and is left alone.
;
; A move that fails (the parent folder cannot be written, as under Program Files) does not stop
; the install: the first start reads the tree from <INSTDIR>\data and copies it into the profile
; from there (src/main.mjs bundledDataHome).
!macro customInstall
  ${StdUtils.GetParentPath} $R0 "$INSTDIR"
  ${If} $R0 == ""
    Goto dsbDataDone
  ${EndIf}
  ; The data home beside the program. $R7 stays 0 while every move succeeds; a failure keeps
  ; the copy in <INSTDIR>\data so the first start can read it from there.
  StrCpy $R1 "$R0\data"
  StrCpy $R7 0

  ; The factory list: a plain-text name per line (build writes it in build/data/factory).
  ; The first start reads the JSON copy from the same folder; both are build output.
  ${If} ${FileExists} "$INSTDIR\data\factory\plugins.txt"
    ClearErrors
    FileOpen $R2 "$INSTDIR\data\factory\plugins.txt" r
    ${If} ${Errors}
      DetailPrint "LinkHarness: the factory plugin list could not be read."
      Goto dsbFactoryDone
    ${EndIf}
    dsbFactoryLoop:
      FileRead $R2 $3
      ${If} $3 == ""
        Goto dsbFactoryEnd
      ${EndIf}
      ; Trim the trailing newline/CR from the name.
      StrCpy $4 $3 -1
      ${If} $4 == ""
        Goto dsbFactoryLoop
      ${EndIf}
      StrCpy $5 "$INSTDIR\data\profiles\ds-bot\node_modules\$4"
      StrCpy $6 "$R1\profiles\ds-bot\node_modules\$4"
      ${If} ${FileExists} "$5\*.*"
        ClearErrors
        RMDir /r "$6"
        CreateDirectory "$6"
        CopyFiles /SILENT "$5\*.*" "$6"
        ${If} ${Errors}
          DetailPrint "LinkHarness: the plugin $4 could not be moved to the data folder."
          StrCpy $R7 1
        ${EndIf}
      ${EndIf}
      Goto dsbFactoryLoop
    dsbFactoryEnd:
      FileClose $R2
    dsbFactoryDone:
  ${EndIf}
  ; The factory list itself travels as build output, so the first start can tell the factory
  ; plugins from the ones the user installed later.
  ${If} ${FileExists} "$INSTDIR\data\factory\*.*"
    CreateDirectory "$R1\factory"
    CopyFiles /SILENT "$INSTDIR\data\factory\*.*" "$R1\factory"
  ${EndIf}
  ; The language servers travel as plain files: they are native programs the Host finds on its
  ; PATH, so the whole folder is moved beside the data.
  ${If} ${FileExists} "$INSTDIR\data\lsp\*.*"
    ClearErrors
    RMDir /r "$R1\lsp"
    CreateDirectory "$R1\lsp"
    CopyFiles /SILENT "$INSTDIR\data\lsp\*.*" "$R1\lsp"
    ${If} ${Errors}
      DetailPrint "LinkHarness: the language servers could not be moved to the data folder."
      StrCpy $R7 1
    ${EndIf}
  ${EndIf}
  ; The factory skills: replace the installed copies, keeping one .bak of each replaced skill,
  ; and leave the skills the package does not carry alone. The sync state file is dropped when
  ; the package carries skills, so the next start re-records versions instead of downloading
  ; what the package just put in place.
  ${If} ${FileExists} "$INSTDIR\data\skills\*.*"
    Delete "$R1\skills-sync.json"
    FindFirst $R2 $3 "$INSTDIR\data\skills\*.*"
    dsbSkillsLoop:
      StrCmp $3 "" dsbSkillsEnd
      StrCmp $3 "." dsbSkillsNext
      StrCmp $3 ".." dsbSkillsNext
      ${If} ${FileExists} "$INSTDIR\data\skills\$3\*.*"
        StrCpy $5 "$INSTDIR\data\skills\$3"
        StrCpy $6 "$R1\skills\$3"
        ${If} ${FileExists} "$6\*.*"
          RMDir /r "$R1\skills\$3.bak"
          CreateDirectory "$R1\skills\$3.bak"
          CopyFiles /SILENT "$6\*.*" "$R1\skills\$3.bak"
        ${EndIf}
        ClearErrors
        RMDir /r "$6"
        CreateDirectory "$6"
        CopyFiles /SILENT "$5\*.*" "$6"
        ${If} ${Errors}
          DetailPrint "LinkHarness: the skill $3 could not be moved to the data folder."
          StrCpy $R7 1
        ${EndIf}
      ${EndIf}
      dsbSkillsNext:
      FindNext $R2 $3
      Goto dsbSkillsLoop
    dsbSkillsEnd:
    FindClose $R2
  ${EndIf}
  ; Only when everything was moved is the installer's own data tree removed. A failed move
  ; leaves it in place: the first start reads the factory tree from <INSTDIR>\data instead.
  ${If} $R7 == 0
    RMDir /r "$INSTDIR\data"
  ${EndIf}
  dsbDataDone:
!macroend
