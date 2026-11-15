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

; The factory plugins (a DSH home tree: profiles/ds-bot/node_modules/<plugin>), the shared
; agents root (skills and the factory AGENTS.md) and the factory list travel beside the program
; as ONE 7z archive, <INSTDIR>\data.7z (extraFiles). The data home of an install is the folder
; beside the program, so the installer unpacks the archive there, once, and deletes it.
;
; Why an archive: unpacked in the payload the same 11,583 files would be written three times —
; electron-builder unpacks its own archive to a temp folder, copies that to $INSTDIR, and this
; macro moved the tree again. As one archive the install carries a single file and creates each
; file once.
;
; The archive is unpacked into a temporary folder first and the two whitelisted subtrees are then
; moved into place, rather than unpacking over the data home: the data home holds the user's own
; data (bot/, profiles/, sessions/ ...), and a plugin the user installed themselves must not be
; replaced or removed by an upgrade. Inside profiles only the names on the factory list are
; written; a skill the package does not carry is the user's own and is left alone.
;
; A move that fails (the parent folder cannot be written, as under Program Files) does not stop
; the install: the archive itself is kept and the first start unpacks the tree from it into the
; profile (src/main.mjs bundledDataHome).
!macro customInstall
  ${StdUtils.GetParentPath} $R0 "$INSTDIR"
  ${If} $R0 == ""
    Goto dsbDataDone
  ${EndIf}
  ; The data home beside the program. $R7 stays 0 while everything lands; a failure keeps
  ; $INSTDIR\data.7z so the first start can unpack it from there.
  StrCpy $R1 "$R0\data"
  StrCpy $R7 0

  ${IfNot} ${FileExists} "$INSTDIR\data.7z"
    DetailPrint "LinkHarness: the data archive is missing, so the factory tree is not installed."
    Goto dsbDataDone
  ${EndIf}

  ; Unpack once into a scratch folder under the program folder, so both the unpack and the moves
  ; stay on the same volume and a half-written tree never sits in the data home.
  StrCpy $R8 "$INSTDIR\dsb-unpack"
  RMDir /r "$R8"
  CreateDirectory "$R8"
  ClearErrors
  SetOutPath "$R8"
  Nsis7z::Extract "$INSTDIR\data.7z"
  Pop $R9
  SetOutPath "$INSTDIR"
  ${If} $R9 != ""
    DetailPrint "LinkHarness: the data archive could not be unpacked ($R9)."
    RMDir /r "$R8"
    StrCpy $R7 1
    Goto dsbDataDone
  ${EndIf}

  ; The factory list: a plain-text name per line (build writes it in the data tree's factory).
  ; The first start reads the JSON copy from the same folder; both are build output.
  ${If} ${FileExists} "$R8\factory\plugins.txt"
    ClearErrors
    FileOpen $R2 "$R8\factory\plugins.txt" r
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
      StrCpy $5 "$R8\profiles\ds-bot\node_modules\$4"
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
  ${If} ${FileExists} "$R8\factory\*.*"
    CreateDirectory "$R1\factory"
    CopyFiles /SILENT "$R8\factory\*.*" "$R1\factory"
  ${EndIf}
  ; The language servers travel as plain files: they are native programs the Host finds on its
  ; PATH, so the whole folder is moved beside the data.
  ${If} ${FileExists} "$R8\lsp\*.*"
    ClearErrors
    RMDir /r "$R1\lsp"
    CreateDirectory "$R1\lsp"
    CopyFiles /SILENT "$R8\lsp\*.*" "$R1\lsp"
    ${If} ${Errors}
      DetailPrint "LinkHarness: the language servers could not be moved to the data folder."
      StrCpy $R7 1
    ${EndIf}
  ${EndIf}
  ; The factory skills live in the shared agents root of the data home (<data>\.agents\skills),
  ; which the app hands the Host as DSH_AGENTS_HOME. They are replaced outright: this is a
  ; factory component, and a previous copy is not kept. A skill the package does not carry is
  ; the user's own and is left alone. The sync state file is dropped when the package carries
  ; skills, so the next start re-records versions instead of downloading what the package just
  ; put in place.
  ${If} ${FileExists} "$R8\.agents\skills\*.*"
    Delete "$R1\skills-sync.json"
    FindFirst $R2 $3 "$R8\.agents\skills\*.*"
    dsbSkillsLoop:
      StrCmp $3 "" dsbSkillsEnd
      StrCmp $3 "." dsbSkillsNext
      StrCmp $3 ".." dsbSkillsNext
      ${If} ${FileExists} "$R8\.agents\skills\$3\*.*"
        StrCpy $5 "$R8\.agents\skills\$3"
        StrCpy $6 "$R1\.agents\skills\$3"
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
  ; The factory rules go where the Host reads the shared root's AGENTS.md. They are the package's
  ; own, so an upgraded install takes the shipping ones. The user's own rules are in
  ; <data>\AGENTS.md, which this never writes.
  ${If} ${FileExists} "$R8\.agents\AGENTS.md"
    CreateDirectory "$R1\.agents"
    CopyFiles /SILENT "$R8\.agents\AGENTS.md" "$R1\.agents\AGENTS.md"
  ${EndIf}
  ; A failure keeps the unpacked tree where the first start looks for it: <INSTDIR>\data
  ; (src/main.mjs bundledDataHome reads the factory list from there when the data home has none).
  ; Only a complete move is cleaned up.
  ${If} $R7 == 0
    RMDir /r "$R8"
    Delete "$INSTDIR\data.7z"
  ${Else}
    DetailPrint "LinkHarness: the factory tree stays in $INSTDIR\data for the first start."
    RMDir /r "$INSTDIR\data"
    Rename "$R8" "$INSTDIR\data"
    Delete "$INSTDIR\data.7z"
  ${EndIf}
  dsbDataDone:
!macroend
