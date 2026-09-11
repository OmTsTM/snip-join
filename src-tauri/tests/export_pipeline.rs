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
    let output = workspace().join(name);
    let _ = std::fs::remove_file(&output);

    let caps = capabilities::capabilities().await.expect("capabilities");
    let plan = export_plan::plan(
        source,
        edit,
        &spec,
        caps,
        &output,
        &workspace(),
        &format!("test-{name}"),
    )
    .expect("the export must plan");

    let (_tx, rx) = tokio::sync::watch::channel(false);
    executor::run_plan(&plan, rx, |_| {})
        .await
        .unwrap_or_else(|e| panic!("export {name} failed: {e}"));

    assert!(output.exists(), "{name} produced no file");
    output
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
        Clip::new(TimeRange::from_seconds(0.0, 10.0).unwrap(), Instant::ZERO),
        Clip::new(TimeRange::from_seconds(20.0, 30.0).unwrap(), Instant::new(20.0).unwrap()),
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
        &source,
        &edit,
        &ExportSpec::fast(),
        caps,
        &output,
        &workspace(),
        "cancel-test",
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
        found.positions.len() >= 2,
        "the fixture should carry several cut points, got {:?}",
        found.positions
    );

    // Pick a real cut point in the middle of the clip and cut exactly there.
    let cut = found
        .positions
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

    let first = found.positions.first().copied().expect("at least one cut point");
    assert!(first < 0.5, "a video always opens on a cut point, got {first}");

    // Between two cut points, a copy falls back to the earlier one.
    if let Some(&second) = found.positions.get(1) {
        let between = (first + second) / 2.0;
        assert_eq!(
            found.at_or_before(between),
            Some(first),
            "a cut between cut points has to resolve backwards, never forwards"
        );
    }
}
