# VHS tape — renders the doom-loop demo to a GIF.
# Install VHS:  https://github.com/charmbracelet/vhs
# Render:       vhs demo/regressionledger.tape   ->   demo/regressionledger.gif
#
# (Rendering needs a real terminal/TTY, so it's run by a human, not in CI.)

Output demo/regressionledger.gif

Set Shell bash
Set FontSize 18
Set Width 1180
Set Height 760
Set Theme "Dracula"
Set Padding 24

Sleep 500ms
Type "node demo/simulate.js"
Sleep 800ms
Enter
Sleep 6s
