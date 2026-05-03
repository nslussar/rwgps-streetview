// Reads segments.json and renders the demo video via ffmpeg. Re-run after any
// edit to segments.json — frame ranges, captions, lingers, title text are all
// driven from there. Defaults output to screenmovies/cut.mov; pass `-o path`
// to override.
//
// Requires ffmpeg-full (with libfreetype + libass + xfade). Override the
// binary or font with FFMPEG / FONT env vars.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FONT = process.env.FONT || '/System/Library/Fonts/Supplemental/Arial.ttf';
const SCREENMOVIES = path.resolve(__dirname, 'screenmovies');
const SPEC_PATH = path.resolve(__dirname, 'segments.json');

const CAPTION_FONTSIZE = 72;
const CANVAS_W = 2940;
const CANVAS_H = 1912;
const CANVAS_FPS = 60;

function main() {
  const argv = process.argv.slice(2);
  const oIdx = argv.indexOf('-o');
  const outFile = oIdx >= 0 ? argv[oIdx + 1] : path.join(SCREENMOVIES, 'cut.mov');

  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf-8'));
  const sourceFiles = Object.keys(spec.sources);
  const srcIndex = Object.fromEntries(sourceFiles.map((s, i) => [s, i]));

  for (const src of sourceFiles) {
    const p = path.join(SCREENMOVIES, src);
    if (!fs.existsSync(p)) {
      console.error(`Missing source file: ${p}`);
      process.exit(1);
    }
  }

  const xfadeDur = spec.transitions.duration_s;
  const defaultLinger = spec.transitions.default_linger_s;
  const titleDur = spec.title_card.duration_s;

  const segs = spec.segments.map((s, i) => {
    const tr = s.time_range_s;
    if (!tr || tr[0] == null || tr[1] == null) {
      console.error(`Segment "${s.id}" has no time_range_s — fill in frames first.`);
      process.exit(1);
    }
    const dur = tr[1] - tr[0];
    const linger = s.linger_s ?? defaultLinger;
    const padDur = linger + xfadeDur;
    return {
      id: s.id,
      label: `v${i}`,
      caption: s.caption,
      sourceIdx: srcIndex[s.source],
      tStart: tr[0],
      tEnd: tr[1],
      duration: dur,
      linger,
      padDur,
      paddedLength: dur + padDur,
    };
  });

  // Chained xfade math:
  //   cum[0] = paddedLength[0]
  //   for i >= 1: offset[i] = cum[i-1] - xfadeDur
  //               cum[i]    = offset[i] + paddedLength[i]
  // The last segment then xfades into the title clip with the same formula.
  let cum = segs[0].paddedLength;
  segs[0].cumOutputLength = cum;
  for (let i = 1; i < segs.length; i++) {
    const offset = cum - xfadeDur;
    segs[i].xfadeOffset = offset;
    cum = offset + segs[i].paddedLength;
    segs[i].cumOutputLength = cum;
  }
  const titleOffset = cum - xfadeDur;
  const finalLength = titleOffset + titleDur;

  // Caption visibility windows: from end of fade-in (or 0 for first segment)
  // until the next segment's xfade-out begins (or titleOffset for last segment).
  segs.forEach((seg, i) => {
    seg.captionStart = i === 0 ? 0 : seg.xfadeOffset + xfadeDur;
    seg.captionEnd = i === segs.length - 1 ? titleOffset : segs[i + 1].xfadeOffset;
  });

  const lines = [];
  segs.forEach(seg => {
    lines.push(
      `[${seg.sourceIdx}:v]trim=start=${num(seg.tStart)}:end=${num(seg.tEnd)},` +
        `setpts=PTS-STARTPTS,fps=${CANVAS_FPS},` +
        `tpad=stop_mode=clone:stop_duration=${num(seg.padDur)}[${seg.label}p]`
    );
  });

  const titleText = escapeDrawtext(spec.title_card.text);
  lines.push(
    `color=c=black:s=${CANVAS_W}x${CANVAS_H}:r=${CANVAS_FPS}:d=${titleDur},format=yuv420p,` +
      `drawtext=fontfile=${FONT}:text='${titleText}':fontsize=${spec.title_card.font_size}:` +
      `fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2[title]`
  );

  let prev = 'v0p';
  for (let i = 1; i < segs.length; i++) {
    const out = `x${i}`;
    lines.push(
      `[${prev}][${segs[i].label}p]xfade=transition=fadeblack:duration=${xfadeDur}:` +
        `offset=${num(segs[i].xfadeOffset)}[${out}]`
    );
    prev = out;
  }
  const finalXfade = 'xall';
  lines.push(
    `[${prev}][title]xfade=transition=fadeblack:duration=${xfadeDur}:offset=${num(titleOffset)}[${finalXfade}]`
  );

  const captionFilters = segs.map(seg => {
    const text = escapeDrawtext(seg.caption);
    return `drawtext=fontfile=${FONT}:text='${text}':fontcolor=white:fontsize=${CAPTION_FONTSIZE}:` +
      `box=1:boxcolor=black@0.65:boxborderw=24:x=(w-text_w)/2:y=h-th-80:` +
      `enable='between(t\\,${num(seg.captionStart)}\\,${num(seg.captionEnd)})'`;
  }).join(',');
  lines.push(`[${finalXfade}]${captionFilters}[out]`);

  const filterComplex = lines.join(';\n');

  const inputArgs = sourceFiles.flatMap(src => ['-i', path.join(SCREENMOVIES, src)]);
  const ffmpegArgs = [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-an',
    outFile,
  ];

  console.log(`Sources: ${sourceFiles.join(', ')}`);
  console.log(`Segments: ${segs.length} + title card`);
  console.log(`Output length: ${finalLength.toFixed(2)}s → ${outFile}`);
  console.log('');
  segs.forEach(seg => {
    console.log(
      `  [${seg.captionStart.toFixed(2)}–${seg.captionEnd.toFixed(2)}s] ` +
      `${seg.id} (linger ${seg.linger}s) — "${seg.caption}"`
    );
  });
  console.log(`  [${titleOffset.toFixed(2)}–${finalLength.toFixed(2)}s] title — "${spec.title_card.text}"`);
  console.log('');

  const r = spawnSync(FFMPEG, ffmpegArgs, { stdio: 'inherit' });
  process.exit(r.status || 0);
}

function num(n) { return Number(n).toFixed(3); }

function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

main();
