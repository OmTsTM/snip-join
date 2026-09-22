//! End-to-end checks that drive real FFmpeg.
//!
//! The unit tests assert on the commands that get built; these assert on the
//! files that come out. That distinction matters because an argument list can be
//! perfectly well formed and still produce a video of the wrong length, or a
//! hole that is not actually black.
//!
//! A fixture is generated once per run rather than committed, so the suite has
//! no binary dependency and stays honest about what FFmpeg on this machine does.

use std::path::{Path, PathBuf};

use snipjoin_lib::application::export_plan;
use snipjoin_lib::domain::edl::{Clip, EditList};
use snipjoin_lib::domain::export::{
    ExportMode, ExportSpec, QualityTarget, Restoration, RestorationLevel, ScaleTarget,
    UpscaleAlgorithm,
};
use snipjoin_lib::domain::media::MediaSource;
use snipjoin_lib::domain::time::{Instant, TimeRange};
use snipjoin_lib::infrastructure::executor;
use snipjoin_lib::infrastructure::ffmpeg::{capabilities, keyframes, locator, probe, runner};

const FIXTURE_SECONDS: f64 = 30.0;

fn workspace() -> PathBuf {
    let dir = std::env::temp_dir().join("snipjoin-e2e");
    std::fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

/// Builds a thirty second clip with a distinct colour every ten seconds.
///
/// The colour bands are what make the assertions meaningful: after a cut, the
/// colour at a given timestamp says which part of the source survived, which a
/// duration check alone cannot.
async fn fixture() -> PathBuf {
    let path = workspace().join("source.mp4");
    if path.exists() {
        return path;
    }

    let tools = locator::tools().expect("FFmpeg must be installed to run these tests");
    let filter = "color=c=red:s=320x180:r=30:d=10[a];\
                  color=c=green:s=320x180:r=30:d=10[b];\
                  color=c=blue:s=320x180:r=30:d=10[c];\
                  [a][b][c]concat=n=3:v=1:a=0[v]";

    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-filter_complex",
        filter,
        "-map",
        "[v]",
        "-map",
        "0:a",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-t",
        "30",
        &path.to_string_lossy(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    runner::run_capturing_stdout(&tools.ffmpeg, &args)
        .await
        .expect("the fixture could not be produced");

    path
}

/// A second clip, in colours the first fixture never shows.
///
/// Yellow and magenta are what make the assertions meaningful: a frame taken
/// from this file cannot be mistaken for one of the red, green or blue bands
/// of the first, so the output proves both inputs were read.
async fn second_fixture() -> PathBuf {
    let path = workspace().join("second.mp4");
    if path.exists() {
        return path;
    }

    let tools = locator::tools().expect("FFmpeg must be installed to run these tests");
    let filter = "color=c=yellow:s=320x180:r=30:d=6[a];                  color=c=magenta:s=320x180:r=30:d=6[b];                  [a][b]concat=n=2:v=1:a=0[v]";

    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-filter_complex",
        filter,
        "-map",
        "[v]",
        "-map",
        "0:a",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-t",
        "12",
        &path.to_string_lossy(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    runner::run_capturing_stdout(&tools.ffmpeg, &args)
        .await
        .expect("the second fixture could not be produced");

    path
}

/// A single green picture, as a real PNG on disk.
///
/// Green rather than one of the fixture's own bands would be ambiguous, so this
/// is deliberately the same green: what the assertions turn on is the *length*
/// the still is stretched to, which no video in this suite could produce by
/// accident.
async fn still_fixture() -> PathBuf {
    let path = workspace().join("card.png");
    if path.exists() {
        return path;
    }

    let tools = locator::tools().expect("FFmpeg must be installed to run these tests");
    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=green:s=320x180",
        "-frames:v",
        "1",
        &path.to_string_lossy(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    runner::run_capturing_stdout(&tools.ffmpeg, &args)
        .await
        .expect("the still fixture could not be produced");

    path
}

/// Container duration of a produced file, in seconds.
async fn duration_of(path: &Path) -> f64 {
    let tools = locator::tools().unwrap();
    let args: Vec<String> = [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        &path.to_string_lossy(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    runner::run_capturing_stdout(&tools.ffprobe, &args)
        .await
        .expect("duration")
        .trim()
        .parse()
        .expect("a numeric duration")
}

/// Average luma of the frame at `at` seconds, from 0 (black) to 255.
async fn luma_at(path: &Path, at: f64) -> f64 {
    let tools = locator::tools().unwrap();
    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-ss",
        &format!("{at:.3}"),
        "-i",
        &path.to_string_lossy(),
        "-frames:v",
        "1",
        "-vf",
        "scale=8:8,format=gray",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    let bytes = runner::run_capturing_bytes(&tools.ffmpeg, &args).await.expect("a decodable frame");
    assert!(!bytes.is_empty(), "no frame was returned at {at}s");

    bytes.iter().map(|b| *b as f64).sum::<f64>() / bytes.len() as f64
}

/// Dominant colour channel of the frame at `at` seconds.
async fn colour_at(path: &Path, at: f64) -> (u8, u8, u8) {
    let tools = locator::tools().unwrap();
    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-ss",
        &format!("{at:.3}"),
        "-i",
        &path.to_string_lossy(),
        "-frames:v",
        "1",
        "-vf",
        "scale=1:1,format=rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    let bytes = runner::run_capturing_bytes(&tools.ffmpeg, &args).await.expect("a decodable frame");
    assert!(bytes.len() >= 3, "no pixel was returned at {at}s");
    (bytes[0], bytes[1], bytes[2])
}

fn dominant(colour: (u8, u8, u8)) -> &'static str {
    let (r, g, b) = colour;
    if r > g + 40 && r > b + 40 {
        "red"
    } else if g > r + 40 && g > b + 40 {
        "green"
    } else if b > r + 40 && b > g + 40 {
        "blue"
    } else if r < 40 && g < 40 && b < 40 {
        "black"
    } else {
        "other"
    }
}

async fn probe_fixture() -> MediaSource {
    let path = fixture().await;
    probe::probe(&path).await.expect("the fixture must probe")
}

/// Plans and runs an export, returning the destination.
async fn export(source: &MediaSource, edit: &EditList, spec: ExportSpec, name: &str) -> PathBuf {
    export_media(std::slice::from_ref(source), edit, spec, name).await
}

/// The same, for a timeline that draws on more than one file.
async fn export_media(
    media: &[MediaSource],
    edit: &EditList,
    spec: ExportSpec,
    name: &str,
) -> PathBuf {
    let (output, _) = export_media_planned(media, edit, spec, name).await;
    output
}

/// Plans with each file's keyframe index, as the application does, and answers
/// with the plan as well so a test can assert on what was copied.
async fn export_media_planned(
    media: &[MediaSource],
    edit: &EditList,
    spec: ExportSpec,
    name: &str,
) -> (PathBuf, export_plan::ExportPlan) {
    let output = workspace().join(name);
    let _ = std::fs::remove_file(&output);

    let mut cut_points = Vec::with_capacity(media.len());
    for source in media {
        cut_points.push(if source.is_still() {
            None
        } else {
            keyframes::probe(Path::new(&source.path)).await.ok()
        });
    }

    let caps = capabilities::capabilities().await.expect("capabilities");
    let plan = export_plan::plan(
        media,
        edit,
        &spec,
        caps,
        &output,
        &workspace(),
        &format!("test-{name}"),
        &cut_points,
    )
    .expect("the export must plan");
    let (_tx, rx) = tokio::sync::watch::channel(false);
    executor::run_plan(&plan, rx, |_| {})
        .await
        .unwrap_or_else(|e| panic!("export {name} failed: {e}"));

    assert!(output.exists(), "{name} produced no file");
    (output, plan)
}

/// Decoded frame count of a produced file.
async fn frames_of(path: &Path) -> u64 {
    let tools = locator::tools().unwrap();
    let args: Vec<String> = [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_entries",
        "stream=nb_read_frames",
        "-of",
        "csv=p=0",
        &path.to_string_lossy(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    runner::run_capturing_stdout(&tools.ffprobe, &args)
        .await
        .expect("frame count")
        .trim()
        .trim_end_matches(',')
        .parse()
        .expect("a numeric frame count")
}

/// Everything the decoder complains about while reading the whole file.
///
/// A seam between a copied piece and a re-encoded one is where a decoder
/// finds a reference it does not have, and it says so here rather than in the
/// exit code, so this is the only check that sees it.
fn decode_errors(path: &Path) -> String {
    let tools = locator::tools().unwrap();
    let output = std::process::Command::new(&tools.ffmpeg)
        .args(["-hide_banner", "-nostdin", "-v", "error", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .output()
        .expect("FFmpeg runs");
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

/// The frame index at which each colour band begins, frame by frame.
///
/// Every frame is reduced to one pixel and classified, with the timestamps
/// passed through so nothing is duplicated to fill a gap. This is what makes
/// "the cut landed on the frame" a statement about a frame number rather than
/// about a timestamp with a tolerance.
async fn band_changes(path: &Path) -> Vec<(usize, &'static str)> {
    let tools = locator::tools().unwrap();
    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-i",
        &path.to_string_lossy(),
        "-vf",
        "scale=1:1,format=rgb24",
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    let bytes = runner::run_capturing_bytes(&tools.ffmpeg, &args).await.expect("frames");
    let mut changes = Vec::new();
    let mut previous = "";
    for (index, pixel) in bytes.chunks_exact(3).enumerate() {
        let colour = dominant((pixel[0], pixel[1], pixel[2]));
        if colour != previous {
            changes.push((index, colour));
            previous = colour;
        }
    }
    changes
}

/// Thirty seconds with a keyframe every three seconds and three B-frames
/// between references, in the same colour bands as the main fixture.
///
/// This is the shape of ordinary footage, and it is what the main fixture is
/// not: `ultrafast` writes no B-frames, so a cut bounded by decode timestamps
/// happens to come out right on it and wrong on everything a phone records.
async fn bframes_fixture() -> PathBuf {
    let path = workspace().join("bframes.mp4");
    if path.exists() {
        return path;
    }

    let tools = locator::tools().expect("FFmpeg must be installed to run these tests");
    let filter = "color=c=red:s=320x180:r=30:d=10[a];\
                  color=c=green:s=320x180:r=30:d=10[b];\
                  color=c=blue:s=320x180:r=30:d=10[c];\
                  [a][b][c]concat=n=3:v=1:a=0[v]";

    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-filter_complex",
        filter,
        "-map",
        "[v]",
        "-map",
        "0:a",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-g",
        "90",
        "-bf",
        "3",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-t",
        "30",
        &path.to_string_lossy(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    runner::run_capturing_stdout(&tools.ffmpeg, &args)
        .await
        .expect("the B-frame fixture could not be produced");

    path
}

/// Twelve seconds of HEVC with open groups of pictures every second: every
/// keyframe but the first is followed in the file by pictures shown before it.
async fn open_gop_fixture() -> PathBuf {
    let path = workspace().join("open-gop.mp4");
    if path.exists() {
        return path;
    }

    let tools = locator::tools().expect("FFmpeg must be installed to run these tests");
    let filter = "color=c=red:s=320x180:r=30:d=4[a];\
                  color=c=green:s=320x180:r=30:d=4[b];\
                  color=c=blue:s=320x180:r=30:d=4[c];\
                  [a][b][c]concat=n=3:v=1:a=0[v]";

    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-filter_complex",
        filter,
        "-map",
        "[v]",
        "-map",
        "0:a",
        "-c:v",
        "libx265",
        "-preset",
        "ultrafast",
        "-x265-params",
        "keyint=30:min-keyint=30:open-gop=1:bframes=2:scenecut=0:log-level=error",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-t",
        "12",
        &path.to_string_lossy(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    runner::run_capturing_stdout(&tools.ffmpeg, &args)
        .await
        .expect("the open-GOP fixture could not be produced");

    path
}

/// The B-frame fixture again, carrying the display matrix a phone writes for
/// a portrait recording: stored sideways, shown upright.
async fn rotated_fixture() -> PathBuf {
    let path = workspace().join("rotated.mp4");
    if path.exists() {
        return path;
    }

    let source = bframes_fixture().await;
    let tools = locator::tools().expect("FFmpeg must be installed to run these tests");
    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-display_rotation",
        "-90",
        "-i",
        &source.to_string_lossy(),
        "-c",
        "copy",
        &path.to_string_lossy(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    runner::run_capturing_stdout(&tools.ffmpeg, &args)
        .await
        .expect("the rotated fixture could not be produced");

    path
}

#[tokio::test]
async fn removing_the_middle_and_joining_shortens_the_video() {
    let source = probe_fixture().await;
    assert_eq!(source.duration.seconds().round(), FIXTURE_SECONDS);

    // Remove the green band (10s to 20s) and close the hole.
    let edit = EditList::contiguous(vec![
        TimeRange::from_seconds(0.0, 10.0).unwrap(),
        TimeRange::from_seconds(20.0, 30.0).unwrap(),
    ])
    .unwrap();

    let spec = ExportSpec {
        mode: ExportMode::Precise,
        quality: QualityTarget::Balanced,
        ..ExportSpec::fast()
    };

    let output = export(&source, &edit, spec, "joined.mp4").await;

    let duration = duration_of(&output).await;
    assert!((duration - 20.0).abs() < 0.4, "expected a 20 second result, got {duration}");

    // Red still leads, and blue now starts where green used to be.
    assert_eq!(dominant(colour_at(&output, 5.0).await), "red");
    assert_eq!(
        dominant(colour_at(&output, 15.0).await),
        "blue",
        "the piece after the cut must move up to meet the piece before it"
    );
}

#[tokio::test]
async fn removing_the_middle_without_joining_leaves_a_black_silent_hole() {
    let source = probe_fixture().await;

    // The same removal, but the surviving pieces keep their original positions.
    let edit = EditList::new(vec![
        Clip::new(0, TimeRange::from_seconds(0.0, 10.0).unwrap(), Instant::ZERO),
        Clip::new(0, TimeRange::from_seconds(20.0, 30.0).unwrap(), Instant::new(20.0).unwrap()),
    ])
    .unwrap();

    let spec = ExportSpec {
        mode: ExportMode::Precise,
        quality: QualityTarget::Balanced,
        ..ExportSpec::fast()
    };

    let output = export(&source, &edit, spec, "gapped.mp4").await;

    let duration = duration_of(&output).await;
    assert!(
        (duration - 30.0).abs() < 0.4,
        "a hole must preserve the original length, got {duration}"
    );

    assert_eq!(dominant(colour_at(&output, 5.0).await), "red");
    assert!(
        luma_at(&output, 15.0).await < 4.0,
        "the hole must be black, not a frozen or repeated frame"
    );
    assert_eq!(
        dominant(colour_at(&output, 25.0).await),
        "blue",
        "material after the hole must stay where it was"
    );
}

#[tokio::test]
async fn blocks_can_be_reordered_and_the_export_follows() {
    let source = probe_fixture().await;

    // Blue first, then red, with green dropped entirely.
    let edit = EditList::contiguous(vec![
        TimeRange::from_seconds(20.0, 30.0).unwrap(),
        TimeRange::from_seconds(0.0, 10.0).unwrap(),
    ])
    .unwrap();

    let spec = ExportSpec {
        mode: ExportMode::Precise,
        quality: QualityTarget::Balanced,
        ..ExportSpec::fast()
    };

    let output = export(&source, &edit, spec, "reordered.mp4").await;

    assert_eq!(dominant(colour_at(&output, 5.0).await), "blue");
    assert_eq!(dominant(colour_at(&output, 15.0).await), "red");
}

#[tokio::test]
async fn a_stream_copy_produces_a_file_without_re_encoding() {
    let source = probe_fixture().await;

    let edit = EditList::contiguous(vec![
        TimeRange::from_seconds(0.0, 10.0).unwrap(),
        TimeRange::from_seconds(20.0, 30.0).unwrap(),
    ])
    .unwrap();

    let output = export(&source, &edit, ExportSpec::fast(), "copied.mp4").await;

    // A copy snaps to keyframes, so the length is approximate by design. The
    // check is that it landed in the right neighbourhood, not on the frame.
    let duration = duration_of(&output).await;
    assert!(
        (15.0..=25.0).contains(&duration),
        "a keyframe-snapped copy should be near 20 seconds, got {duration}"
    );
}

#[tokio::test]
async fn an_upscaled_export_comes_out_at_the_requested_size() {
    let source = probe_fixture().await;
    let caps = capabilities::capabilities().await.expect("capabilities");

    // Exercise whichever GPU kernel this machine actually offers, falling back
    // to the CPU one so the test is meaningful everywhere.
    let upscale = if caps.upscalers.contains(&UpscaleAlgorithm::Detail) {
        UpscaleAlgorithm::Detail
    } else {
        UpscaleAlgorithm::Lanczos
    };

    let edit = EditList::contiguous(vec![TimeRange::from_seconds(0.0, 4.0).unwrap()]).unwrap();

    let spec = ExportSpec {
        mode: ExportMode::Enhanced,
        quality: QualityTarget::Balanced,
        upscale,
        scale: ScaleTarget::Multiplier { factor: 2.0 },
        restoration: Restoration {
            denoise: RestorationLevel::Light,
            sharpen: RestorationLevel::Light,
            deband: true,
        },
        ..ExportSpec::fast()
    };

    let output = export(&source, &edit, spec, "upscaled.mp4").await;
    let probed = probe::probe(&output).await.expect("the result must probe");
    let video = probed.video.expect("the result must have video");

    assert_eq!(
        (video.width, video.height),
        (640, 360),
        "a 2x upscale of 320x180 must land on 640x360"
    );
}

#[tokio::test]
async fn an_export_can_be_cancelled_and_leaves_no_scratch_behind() {
    let source = probe_fixture().await;

    let edit = EditList::contiguous(vec![
        TimeRange::from_seconds(0.0, 10.0).unwrap(),
        TimeRange::from_seconds(20.0, 30.0).unwrap(),
    ])
    .unwrap();

    let output = workspace().join("cancelled.mp4");
    let caps = capabilities::capabilities().await.expect("capabilities");
    let plan = export_plan::plan(
        std::slice::from_ref(&source),
        &edit,
        &ExportSpec::fast(),
        caps,
        &output,
        &workspace(),
        "cancel-test",
        &[],
    )
    .expect("plan");

    let scratch = plan.temp_dir.clone().expect("a multi-piece copy needs scratch space");

    let (tx, rx) = tokio::sync::watch::channel(false);
    // Cancel almost immediately, while the first segment is still being copied.
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let _ = tx.send(true);
    });

    let result = executor::run_plan(&plan, rx, |_| {}).await;

    assert!(result.is_err(), "a cancelled export must not report success");
    assert!(
        !scratch.exists(),
        "the scratch directory must be removed even when the export unwinds early"
    );
}

#[tokio::test]
async fn cutting_on_a_cut_point_copies_without_drifting() {
    let path = fixture().await;
    let source = probe_fixture().await;

    let found = keyframes::probe(&path).await.expect("keyframes must be readable");
    assert!(
        found.positions().len() >= 2,
        "the fixture should carry several cut points, got {:?}",
        found.positions()
    );

    // Pick a real cut point in the middle of the clip and cut exactly there.
    let cut = found
        .positions()
        .iter()
        .copied()
        .find(|&k| k > 5.0 && k < FIXTURE_SECONDS - 5.0)
        .expect("a cut point away from both ends");

    let edit = EditList::contiguous(vec![TimeRange::from_seconds(0.0, cut).unwrap()]).unwrap();

    let output = export(&source, &edit, ExportSpec::fast(), "lossless-exact.mp4").await;
    let duration = duration_of(&output).await;

    // A copy that starts and ends on a cut point lands where it was asked to,
    // which is the whole promise of cutting without re-encoding.
    assert!(
        (duration - cut).abs() < 0.5,
        "cutting at a cut point ({cut}s) should produce {cut}s, got {duration}s"
    );
}

#[tokio::test]
async fn a_copy_reports_where_it_will_really_start() {
    let path = fixture().await;
    let found = keyframes::probe(&path).await.expect("keyframes");

    let first = found.positions().first().copied().expect("at least one cut point");
    assert!(first < 0.5, "a video always opens on a cut point, got {first}");

    // Between two cut points, a copy falls back to the earlier one.
    if let Some(&second) = found.positions().get(1) {
        let between = (first + second) / 2.0;
        assert_eq!(
            found.at_or_before(between),
            Some(first),
            "a cut between cut points has to resolve backwards, never forwards"
        );
    }
}

/// Two files on one timeline, which is the whole point of the media pool: the
/// result has to contain both, in order, at the right lengths.
#[tokio::test]
async fn a_timeline_drawing_on_two_files_exports_both_of_them() {
    let first = probe::probe(&fixture().await).await.expect("the first fixture must probe");
    let second =
        probe::probe(&second_fixture().await).await.expect("the second fixture must probe");

    // Four seconds of the first file's red band, then four of the second's
    // yellow one.
    let edit = EditList::new(vec![
        Clip::new(0, TimeRange::from_seconds(1.0, 5.0).unwrap(), Instant::ZERO),
        Clip::new(1, TimeRange::from_seconds(1.0, 5.0).unwrap(), Instant::new(4.0).unwrap()),
    ])
    .unwrap();

    let spec = ExportSpec {
        mode: ExportMode::Precise,
        quality: QualityTarget::Balanced,
        ..ExportSpec::fast()
    };

    let output = export_media(&[first, second], &edit, spec, "two-files.mp4").await;

    assert!((duration_of(&output).await - 8.0).abs() < 0.5, "eight seconds out of two files");
    assert_eq!(dominant(colour_at(&output, 2.0).await), "red", "the first file's band comes first");

    // Yellow is red and green together, which `dominant` calls neither. What
    // matters is that it is not the first file's red, and that it is bright.
    let (r, g, b) = colour_at(&output, 6.0).await;
    assert!(
        r > 150 && g > 150 && b < 90,
        "the second file's yellow follows it, got ({r}, {g}, {b})"
    );
}

/// A stream copy cannot join packets from two files, whatever their encodings
/// look like. The planner has to notice and re-encode rather than produce a
/// file containing only the first one.
#[tokio::test]
async fn asking_to_copy_a_two_file_timeline_re_encodes_instead() {
    let first = probe::probe(&fixture().await).await.expect("the first fixture must probe");
    let second =
        probe::probe(&second_fixture().await).await.expect("the second fixture must probe");

    let edit = EditList::new(vec![
        Clip::new(0, TimeRange::from_seconds(0.0, 4.0).unwrap(), Instant::ZERO),
        Clip::new(1, TimeRange::from_seconds(0.0, 4.0).unwrap(), Instant::new(4.0).unwrap()),
    ])
    .unwrap();

    let caps = capabilities::capabilities().await.expect("capabilities");
    let output = workspace().join("copy-refused.mp4");
    let plan = export_plan::plan(
        &[first, second],
        &edit,
        &ExportSpec::fast(),
        caps,
        &output,
        &workspace(),
        "test-copy-refused",
        &[],
    )
    .expect("the export must plan");

    assert!(
        plan.effective_mode.re_encodes(),
        "a copy was asked for and silently producing half the timeline would be worse"
    );
}

/// A still is one packet. Everything about putting it on a timeline depends on
/// that packet being looped: without it a five second title card exports as a
/// single frame, which is the shape the defect took on the timeline too — a
/// block two pixels wide because a PNG reports a fortieth of a second.
#[tokio::test]
async fn a_still_exports_for_as_long_as_its_block_asks() {
    let still = probe::probe(&still_fixture().await).await.expect("the still must probe");
    assert!(still.is_still(), "a PNG is a single frame, whatever its container reports");
    assert_eq!(still.duration.seconds(), 5.0, "and the editor gives it an editable length");

    // Six seconds, which is longer than the length it arrives with: a still has
    // no length of its own to run out of.
    let edit = EditList::new(vec![Clip::new(
        0,
        TimeRange::from_seconds(0.0, 6.0).unwrap(),
        Instant::ZERO,
    )])
    .unwrap();

    let spec = ExportSpec {
        mode: ExportMode::Precise,
        quality: QualityTarget::Balanced,
        ..ExportSpec::fast()
    };

    let output = export_media(&[still], &edit, spec, "still.mp4").await;

    let duration = duration_of(&output).await;
    assert!((duration - 6.0).abs() < 0.4, "expected a six second result, got {duration}");
    assert_eq!(dominant(colour_at(&output, 5.5).await), "green", "the picture lasts the whole way");
}

/// The mixed case is the one that actually happens: a title card in front of
/// the footage. It also proves the still is normalised onto the first medium's
/// size and rate, which is what `concat` silently corrupts without.
#[tokio::test]
async fn a_still_can_sit_on_a_timeline_beside_a_video() {
    let video = probe::probe(&fixture().await).await.expect("the fixture must probe");
    let still = probe::probe(&still_fixture().await).await.expect("the still must probe");

    // Three seconds of the card, then three of the video's blue band.
    let edit = EditList::new(vec![
        Clip::new(1, TimeRange::from_seconds(0.0, 3.0).unwrap(), Instant::ZERO),
        Clip::new(0, TimeRange::from_seconds(22.0, 25.0).unwrap(), Instant::new(3.0).unwrap()),
    ])
    .unwrap();

    let spec = ExportSpec {
        mode: ExportMode::Precise,
        quality: QualityTarget::Balanced,
        ..ExportSpec::fast()
    };

    let output = export_media(&[video, still], &edit, spec, "still-and-video.mp4").await;

    assert!((duration_of(&output).await - 6.0).abs() < 0.5, "six seconds out of a card and a clip");
    assert_eq!(dominant(colour_at(&output, 1.5).await), "green", "the card leads");
    assert_eq!(dominant(colour_at(&output, 4.5).await), "blue", "the footage follows it");
}

/// A stream copy cannot loop one packet into a stretch of video, so asking for
/// one has to be promoted rather than honoured — the alternative is a title
/// card that lasts a single frame in the finished file.
#[tokio::test]
async fn asking_to_copy_a_still_re_encodes_instead() {
    let still = probe::probe(&still_fixture().await).await.expect("the still must probe");

    let edit = EditList::new(vec![Clip::new(
        0,
        TimeRange::from_seconds(0.0, 4.0).unwrap(),
        Instant::ZERO,
    )])
    .unwrap();

    let caps = capabilities::capabilities().await.expect("capabilities");
    let output = workspace().join("still-copy-refused.mp4");
    let plan = export_plan::plan(
        &[still],
        &edit,
        &ExportSpec::fast(),
        caps,
        &output,
        &workspace(),
        "test-still-copy",
        &[],
    )
    .expect("the export must plan");

    assert_ne!(plan.effective_mode, ExportMode::Fast, "a still cannot be stream copied");
}

/// The promise on the box: a cut placed between two keyframes lands on the
/// frame it was placed on, and the footage between the cuts is copied rather
/// than re-encoded.
///
/// Red runs to ten seconds, so a clip of `[4.5, 10.0)` is 165 red frames; the
/// second clip starts inside the green band at 19.2 and crosses into blue at
/// 20, so it is 24 green frames and then blue. Checked frame by frame, because
/// a duration with a tolerance would not notice one frame shown twice at a seam.
#[tokio::test]
async fn a_cut_between_keyframes_lands_on_the_frame_and_copies_the_rest() {
    let path = bframes_fixture().await;
    let source = probe::probe(&path).await.expect("the B-frame fixture must probe");

    let edit = EditList::contiguous(vec![
        TimeRange::from_seconds(4.5, 10.0).unwrap(),
        TimeRange::from_seconds(19.2, 25.7).unwrap(),
    ])
    .unwrap();

    let (output, plan) =
        export_media_planned(std::slice::from_ref(&source), &edit, ExportSpec::fast(), "smart.mp4")
            .await;

    assert_eq!(plan.effective_mode, ExportMode::Fast);
    assert!(plan.re_encoded > 0.0, "the frames beside the cuts are re-encoded");
    assert!(
        plan.re_encoded < 8.0,
        "but most of the twelve seconds are copied, got {}",
        plan.re_encoded
    );
    assert!(
        plan.steps.iter().any(|step| step.args.iter().any(|a| a == "-frames:v")),
        "the copied stretches are bounded by packet count"
    );

    assert_eq!(frames_of(&output).await, 360, "5.5 plus 6.5 seconds at thirty frames a second");
    assert_eq!(
        band_changes(&output).await,
        vec![(0, "red"), (165, "green"), (189, "blue")],
        "the seams sit on the exact frames the cuts were placed on"
    );
    assert_eq!(decode_errors(&output), "", "every piece decodes against its neighbours");

    let duration = duration_of(&output).await;
    assert!((duration - 12.0).abs() < 0.1, "expected twelve seconds, got {duration}");
}

/// A hole no longer forces the footage through the encoder: it is drawn as a
/// piece of its own and copied packets sit on either side of it.
#[tokio::test]
async fn a_hole_between_copied_pieces_is_black_and_the_footage_is_untouched() {
    let path = bframes_fixture().await;
    let source = probe::probe(&path).await.expect("the B-frame fixture must probe");

    let edit = EditList::new(vec![
        Clip::new(0, TimeRange::from_seconds(0.0, 10.0).unwrap(), Instant::ZERO),
        Clip::new(0, TimeRange::from_seconds(20.0, 30.0).unwrap(), Instant::new(20.0).unwrap()),
    ])
    .unwrap();

    let (output, plan) = export_media_planned(
        std::slice::from_ref(&source),
        &edit,
        ExportSpec::fast(),
        "smart-hole.mp4",
    )
    .await;

    assert_eq!(plan.effective_mode, ExportMode::Fast, "a hole is drawn, not a reason to re-encode");
    assert!(plan.re_encoded < 4.0, "at most the frames beside the cuts, got {}", plan.re_encoded);

    assert_eq!(frames_of(&output).await, 900, "ten seconds, ten of hole, ten more");
    assert_eq!(
        band_changes(&output).await,
        vec![(0, "red"), (300, "black"), (600, "blue")],
        "the hole starts and ends on the frame"
    );
    assert!(luma_at(&output, 15.0).await < 4.0, "the hole is black, not a held frame");
    assert_eq!(decode_errors(&output), "");
}

/// Open groups of pictures, as HEVC encoders write by default: the pictures
/// that lead a keyframe are stored after it and refer to the group before it.
/// Copied naively they decode into garbage at every cut; stripped from the
/// first copied group and re-encoded before the last, the seams are clean.
#[tokio::test]
async fn an_open_gop_hevc_source_is_cut_cleanly() {
    let path = open_gop_fixture().await;
    let source = probe::probe(&path).await.expect("the open-GOP fixture must probe");
    let index = keyframes::probe(&path).await.expect("keyframes");
    assert!(
        index.entries.iter().skip(1).any(|k| k.leading > 0),
        "the fixture must actually carry leading pictures, got {:?}",
        index.entries
    );

    // Red to four seconds, green to eight: 75 red frames, then 24 green and
    // the blue that follows at eight.
    let edit = EditList::contiguous(vec![
        TimeRange::from_seconds(0.5, 3.0).unwrap(),
        TimeRange::from_seconds(7.2, 11.9).unwrap(),
    ])
    .unwrap();

    let (output, plan) = export_media_planned(
        std::slice::from_ref(&source),
        &edit,
        ExportSpec::fast(),
        "smart-open-gop.mp4",
    )
    .await;

    assert_eq!(plan.effective_mode, ExportMode::Fast);
    assert!(
        plan.steps.iter().any(|step| step.args.iter().any(|a| a.contains("remove_types"))),
        "the leading pictures of the first copied group are stripped"
    );
    assert_eq!(frames_of(&output).await, 216, "2.5 plus 4.7 seconds");
    assert_eq!(band_changes(&output).await, vec![(0, "red"), (75, "green"), (99, "blue")]);
    assert_eq!(decode_errors(&output), "", "no picture is left without its reference");
}

/// A portrait phone clip is stored sideways with a display matrix that turns
/// it upright. The pieces cannot carry the matrix, so the finished file has to
/// have it put back, or the export comes out lying on its side.
#[tokio::test]
async fn a_rotated_source_keeps_its_rotation_through_a_copy() {
    let path = rotated_fixture().await;
    let source = probe::probe(&path).await.expect("the rotated fixture must probe");
    assert_eq!(source.video.as_ref().unwrap().rotation, 90, "the fixture is rotated");

    let edit = EditList::contiguous(vec![TimeRange::from_seconds(4.5, 10.0).unwrap()]).unwrap();
    let (output, plan) = export_media_planned(
        std::slice::from_ref(&source),
        &edit,
        ExportSpec::fast(),
        "smart-rotated.mp4",
    )
    .await;

    assert!(plan.re_encoded > 0.0, "an off-keyframe cut goes through the pieces");
    let probed = probe::probe(&output).await.expect("the result must probe");
    assert_eq!(probed.video.as_ref().unwrap().rotation, 90, "the display matrix survives");
    assert_eq!(frames_of(&output).await, 165);
    assert_eq!(decode_errors(&output), "");
}

/// Cuts snapped onto keyframes copy everything, including the sound, and with
/// the packet count known the copy stops on the frame before the next keyframe
/// instead of a frame or two past it.
#[tokio::test]
async fn a_snapped_copy_shows_no_frame_twice_at_the_seam() {
    let path = bframes_fixture().await;
    let source = probe::probe(&path).await.expect("the B-frame fixture must probe");
    let index = keyframes::probe(&path).await.expect("keyframes");

    // Two keyframes with red on one side and green on the other.
    let before =
        index.entries.iter().rev().find(|k| k.at < 10.0 - 1.5).expect("a keyframe before ten");
    let after = index.entries.iter().find(|k| k.at >= 20.0).expect("a keyframe from twenty");

    let edit = EditList::contiguous(vec![
        TimeRange::from_seconds(0.0, before.at).unwrap(),
        TimeRange::from_seconds(after.at, 30.0).unwrap(),
    ])
    .unwrap();

    let (output, plan) = export_media_planned(
        std::slice::from_ref(&source),
        &edit,
        ExportSpec::fast(),
        "snapped.mp4",
    )
    .await;

    assert_eq!(plan.re_encoded, 0.0, "nothing to re-encode when every cut sits on a keyframe");
    assert!(plan.steps[0].args.contains(&"0:a:0?".to_string()), "the sound is copied too");

    let expected = ((before.at + (30.0 - after.at)) * 30.0).round() as u64;
    assert_eq!(frames_of(&output).await, expected);
    assert_eq!(decode_errors(&output), "");
}
