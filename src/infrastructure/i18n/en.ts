/**
 * English message catalogue, and the source of truth for the message key type.
 *
 * Keys are flat and dotted rather than nested, which gives every other locale a
 * compile-time guarantee that it covers exactly these keys: a missing or
 * misspelled key fails the type check instead of rendering as raw text.
 *
 * Placeholders are `{name}` and are substituted at call time.
 */
export const en = {

  'window.minimize': 'Minimise',
  'window.maximize': 'Maximise',
  'window.close': 'Close',

  'welcome.title': 'Drop a video here',
  'welcome.subtitle': 'Mark the part you do not want, take it out, and keep the rest.',
  'welcome.choose': 'Choose a video',
  'welcome.formats': 'MP4, MOV, MKV, AVI, WebM, WMV, FLV, MTS and more',
  'welcome.opening': 'Reading the file…',
  'welcome.dropNow': 'Let go to open it',

  'source.open': 'Open another video',
  'source.resolution': '{width}x{height}',
  'source.noAudio': 'No sound',

  'preview.preparing': 'Preparing the preview',
  'preview.preparingNote': 'This file needs a lightweight copy to scrub smoothly. The export always reads the original.',
  'preview.proxyBadge': 'Preview copy',
  'preview.proxyTooltip': 'Scrubbing uses a smaller copy. Exporting always reads the original file.',
  'preview.hole': 'Hole',
  'preview.holeNote': 'Black and silent here',

  'transport.play': 'Play',
  'transport.pause': 'Pause',
  'transport.previousFrame': 'Back one frame',
  'transport.nextFrame': 'Forward one frame',
  'transport.volume': 'Volume',
  'transport.mute': 'Mute',
  'transport.unmute': 'Unmute',
  'transport.toStart': 'Go to start',
  'transport.toEnd': 'Go to end',

  'selection.title': 'Selection',
  'selection.empty': 'Drag across the timeline to mark what to take out.',
  'selection.emptyHint': 'Or press I and O to set the two edges at the playhead.',
  'selection.in': 'In',
  'selection.out': 'Out',
  'selection.length': 'Length',
  'selection.setIn': 'Set the start here',
  'selection.setOut': 'Set the end here',
  'selection.clear': 'Clear selection',
  'selection.remove': 'Remove selection',
  'selection.lift': 'Lift out to move',
  'selection.liftHint': 'Turns the selection into its own block so you can drag it elsewhere.',
  'selection.selectAll': 'Select everything',

  'join.label': 'Join the ends',
  'join.on': 'What is left closes up into one continuous video.',
  'join.off': 'The hole stays. It exports as black with silence.',

  'media.title': 'Media',
  'media.add': 'Add a video',
  'media.append': 'Put it on the timeline again',
  'media.remove': 'Remove from the project',
  'media.first': 'Sets the format everything else is matched to',

  'blocks.title': 'Blocks',
  'blocks.one': '1 block',
  'blocks.many': '{count} blocks',
  'blocks.number': 'Block {number}',
  'blocks.delete': 'Delete this block',
  'blocks.split': 'Split at the playhead',
  'blocks.drag': 'Drag to move',
  'blocks.trimStart': 'Trim the start',
  'blocks.trimEnd': 'Trim the end',
  'blocks.hole': 'Hole',
  'blocks.reorderHint': 'Drag a block by its handle to change the order.',
  'blocks.moveHint': 'Drag a block by its handle to move it along the timeline.',

  'timeline.snapCuts': 'Snap cuts to cut points, so the export can just copy',
  'timeline.resize': 'Drag to make the timeline taller. Double-click to reset.',
  'timeline.zoomIn': 'Zoom in',
  'timeline.zoomOut': 'Zoom out',
  'timeline.fit': 'Fit to window',
  'timeline.kept': '{kept} of {total} kept',
  'timeline.removed': '{removed} removed',
  'timeline.loadingFrames': 'Reading the frames…',

  'history.undo': 'Undo',
  'history.redo': 'Redo',

  'export.open': 'Export',
  'export.title': 'Export',
  'export.subtitle': 'Choose how much work to spend on the result.',
  'export.mode': 'Method',
  'export.mode.fast': 'Copy',
  'export.mode.fast.summary': 'Seconds. Identical quality.',
  'export.mode.fast.detail':
    'Nothing is re-encoded, so the result is bit for bit the original and no processor or graphics work is needed. Cuts can only land on a cut point, and the timeline snaps to them, so this is normally exact.',
  'export.mode.precise': 'Precise',
  'export.mode.precise.summary': 'Minutes. Cuts land on the exact frame.',
  'export.mode.precise.detail':
    'The video is re-encoded so every cut lands where you put it. Quality is set to be indistinguishable from the source.',
  'export.mode.enhanced': 'Enhanced',
  'export.mode.enhanced.summary': 'Longer. Adds resolution and clean-up.',
  'export.mode.enhanced.detail':
    'Precise, plus upscaling and restoration. This is the slow one: expect several times the length of the video.',
  'export.mode.forced': 'A hole cannot be copied, so this export re-encodes.',
  'export.mode.forcedByFiles': 'More than one file cannot be copied, so this export re-encodes.',

  'export.lossless.exact': 'Exact cuts. Nothing is re-encoded.',
  'export.lossless.shift': 'Cuts move back up to {shift} to reach the nearest cut point.',
  'export.lossless.anywhere': 'This video can be cut anywhere without re-encoding.',
  'export.lossless.reading': 'Finding the cut points…',

  'export.quality': 'Quality',
  'export.quality.matchSource': 'Match the source',
  'export.quality.high': 'High',
  'export.quality.compact': 'Smaller file',

  'export.codec': 'Format',
  'export.codec.h264': 'H.264',
  'export.codec.h264.note': 'Plays everywhere',
  'export.codec.hevc': 'H.265',
  'export.codec.hevc.note': 'Smaller, needs a recent player',
  'export.codec.av1': 'AV1',
  'export.codec.av1.note': 'Smallest, slowest to encode',

  'export.upscale': 'Resolution',
  'export.upscale.none': 'Keep as is',
  'export.upscale.lanczos': 'Lanczos',
  'export.upscale.lanczos.note': 'Fast, sharp, runs on the processor',
  'export.upscale.placebo': 'EWA Lanczos',
  'export.upscale.placebo.note': 'Cleaner edges, runs on the graphics card',
  'export.upscale.detail': 'EWA + detail',
  'export.upscale.detail.note': 'Adds contrast-aware sharpening. Slowest.',
  'export.upscale.unavailable': 'Needs a graphics card this build can reach',
  'export.scale': 'Size',
  'export.scale.result': '{width} x {height}',

  'export.restoration.denoise': 'Reduce noise',
  'export.restoration.sharpen': 'Sharpen',
  'export.restoration.deband': 'Smooth banding',
  'export.restoration.debandNote': 'Helps gradients that came out blotchy',
  'export.level.off': 'Off',
  'export.level.light': 'Light',
  'export.level.medium': 'Medium',
  'export.level.strong': 'Strong',

  'export.audio': 'Sound',
  'export.audio.copy': 'Keep as is',
  'export.audio.reEncode': 'Re-encode',
  'export.audio.remove': 'Remove',

  'export.destination': 'Save to',
  'export.chooseDestination': 'Choose…',
  'export.estimate': 'About {time}',
  'export.start': 'Export',
  'export.running': 'Exporting',
  'export.cancel': 'Cancel',
  'export.done': 'Exported',
  'export.doneDetail': '{name} · {duration} · {size}',
  'export.reveal': 'Show in folder',
  'export.dismiss': 'Done',
  'export.advanced': 'Advanced',
  'export.summary.blocks': '{count} blocks',
  'export.summary.length': 'Final length {duration}',

  'error.title': 'That did not work',
  'error.ffmpegMissing': 'FFmpeg could not be found. Install it and make sure it is on your PATH.',
  'error.unreadableFile': 'That file could not be read.',
  'error.unsupportedMedia': 'There is no video or audio in that file that can be read.',
  'error.probeFailed': 'That file could not be inspected.',
  'error.encodeFailed': 'The export stopped before it finished.',
  'error.invalidInput': 'That will not work as given.',
  'error.cancelled': 'Cancelled.',
  'error.internal': 'Something went wrong.',
  'error.dismiss': 'Close',

  'shortcuts.title': 'Keyboard',
  'shortcuts.playPause': 'Play or pause',
  'shortcuts.setIn': 'Set the start of the selection',
  'shortcuts.setOut': 'Set the end of the selection',
  'shortcuts.remove': 'Remove the selection',
  'shortcuts.split': 'Split at the playhead',
  'shortcuts.undo': 'Undo',
  'shortcuts.redo': 'Redo',
  'shortcuts.frameStep': 'Step one frame',
  'shortcuts.zoom': 'Zoom the timeline',
  'shortcuts.export': 'Export',
  'shortcuts.show': 'Keyboard shortcuts',

  'language.label': 'Language',

  'about.author': 'by OmTsTM',
  'splash.tagline': 'The cut you see is the cut you get.',
} as const

export type MessageKey = keyof typeof en
export type Catalogue = Record<MessageKey, string>
