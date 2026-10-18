# Ranger workflow motion

A 5.4 second, 1080 × 420 landscape composition built from editable Tesseract rectangles and text. One small progress marker moves along the handoff line from context to plan to build, then holds at the final step.

- `Ranger-workflow.tsrct` is the editable source with the Inter font packaged.
- `../../public/assets/workflow-demo.mp4` is the rendered web video used by the landing page.
- `../../public/assets/workflow-poster.png` is the rendered poster and reduced-motion fallback.
- `.tesseract-work/workflow-filmstrip.png` samples the movement at 0–5.2 seconds.
- `.tesseract-work/OFL.txt` keeps the font redistribution license beside the working source.

The landing page detects `prefers-reduced-motion`; when enabled, it shows the static poster instead of playing the video. The composition contains no audio.
