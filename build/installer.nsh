; Adds an explicit "Open with TraceBox" entry to the Explorer right-click
; context menu for log-like file types (and removes it on uninstall).
;
; SystemFileAssociations verbs appear for ALL files of that extension
; regardless of which app is the default handler — this is what gives the
; right-click "Open with TraceBox" without stealing the default association.

!macro addContextMenu EXT
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\TraceBox" "" "Open with TraceBox"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\TraceBox" "Icon" "$INSTDIR\TraceBox.exe,0"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\TraceBox\command" "" '"$INSTDIR\TraceBox.exe" "%1"'
!macroend

!macro removeContextMenu EXT
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\TraceBox"
!macroend

!macro customInstall
  !insertmacro addContextMenu ".log"
  !insertmacro addContextMenu ".txt"
  !insertmacro addContextMenu ".jsonl"
  !insertmacro addContextMenu ".ndjson"
  !insertmacro addContextMenu ".out"
!macroend

!macro customUnInstall
  !insertmacro removeContextMenu ".log"
  !insertmacro removeContextMenu ".txt"
  !insertmacro removeContextMenu ".jsonl"
  !insertmacro removeContextMenu ".ndjson"
  !insertmacro removeContextMenu ".out"
!macroend
