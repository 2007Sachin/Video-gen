const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ============================================
// CONFIG (read from env for GitHub Actions)
// ============================================
const COMPOSITION_PATH = path.resolve(__dirname, 'index.html');
const OUTPUT_DIR = path.resolve(__dirname, 'output');
const FRAMES_DIR = path.join(OUTPUT_DIR, 'frames');
const FINAL_MP4 = path.join(OUTPUT_DIR, 'fde-course-intro.mp4');

const FPS = parseInt(process.env.FPS) || 30;
const DURATION_SECONDS = parseInt(process.env.DURATION) || 305;
const TOTAL_FRAMES = FPS * DURATION_SECONDS;
const WIDTH = parseInt(process.env.WIDTH) || 1920;
const HEIGHT = parseInt(process.env.HEIGHT) || 1080;

const DEVICE_SCALE_FACTOR = 1;
const QUALITY = process.env.QUALITY || 'high';

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('🎬 FDE Course Intro — MP4 Export');
  console.log(`   Duration: ${DURATION_SECONDS}s @ ${FPS}fps = ${TOTAL_FRAMES} frames`);
  console.log(`   Resolution: ${WIDTH}x${HEIGHT}`);
  console.log(`   Output: ${FINAL_MP4}\n`);

  // Create directories
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });

  // Launch browser
  console.log('🚀 Launching headless Chrome...');
  const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
  console.log(`   Using Chrome: ${chromePath}`);
  
  // Test Chrome exists
  const { execSync } = require('child_process');
  try {
    execSync(`${chromePath} --version`, { stdio: 'pipe' });
    console.log('   ✅ Chrome binary found');
  } catch (e) {
    console.error('   ❌ Chrome binary NOT found at:', chromePath);
    process.exit(1);
  }
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--window-size=${WIDTH},${HEIGHT}`,
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',  // Critical for CI/Docker
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--force-color-profile=srgb',
      '--no-first-run',
      '--no-zygote',
      '--single-process',  // Helps in constrained environments
    ],
    executablePath: chromePath,
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR },
    timeout: 60000,  // 60s launch timeout
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR });
  page.setDefaultTimeout(120000);  // 2 min default timeout

  // Enable console logs from page
  page.on('console', msg => console.log('📄', msg.text()));
  page.on('pageerror', err => console.error('❌ Page error:', err.message));
  page.on('requestfailed', req => console.error('❌ Request failed:', req.url(), req.failure().errorText));

  // Load composition
  const fileUrl = `file://${COMPOSITION_PATH}`;
  console.log(`📥 Loading: ${fileUrl}`);
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // Wait for fonts and initial render
  console.log('⏳ Waiting for fonts...');
  await page.evaluateHandle('document.fonts.ready');
  console.log('✅ Fonts ready');
  await new Promise(r => setTimeout(r, 2000));

  // Get composition controller
  console.log('🔍 Looking for composition controller...');
  const comp = await page.evaluateHandle(() => window.__FDE_COMPOSITION__);
  if (!comp) throw new Error('Composition controller not found on page');
  console.log('✅ Composition controller found');
  
  // Test composition
  const duration = await comp.evaluate(c => c.duration);
  console.log(`   Duration: ${duration}s`);
  const totalFrames = await comp.evaluate(c => c.totalFrames);
  console.log(`   Total frames: ${totalFrames}`);

  // Pause at start
  await comp.evaluate(c => c.pause());
  await comp.evaluate(c => c.seek(0));
  await new Promise(r => setTimeout(r, 1000));

  console.log('🎞️  Capturing frames...');
  const startTime = Date.now();
  let lastLogTime = startTime;

  for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
    const frameTime = frame / FPS;
    
    try {
      // Seek to exact frame time
      await comp.evaluate((c, t) => c.seek(t), frameTime);
      
      // Small wait for GSAP to settle
      await new Promise(r => setTimeout(r, 16)); // ~1 frame at 60fps internal

      // Capture frame
      const framePath = path.join(FRAMES_DIR, `frame_${String(frame).padStart(6, '0')}.png`);
      await page.screenshot({ path: framePath, type: 'png', timeout: 30000 });
    } catch (frameErr) {
      console.error(`\n❌ Frame ${frame} failed:`, frameErr.message);
      await browser.close();
      process.exit(1);
    }

    // Progress log every 5 seconds
    const now = Date.now();
    if (now - lastLogTime > 5000) {
      const elapsed = (now - startTime) / 1000;
      const fps = frame / elapsed;
      const eta = (TOTAL_FRAMES - frame) / fps;
      console.log(`   Frame ${frame}/${TOTAL_FRAMES} (${(frame/TOTAL_FRAMES*100).toFixed(1)}%) — ${fps.toFixed(1)} fps — ETA: ${eta.toFixed(0)}s`);
      lastLogTime = now;
    }
  }

  await browser.close();
  console.log('\n✅ Frame capture complete.');

  // ============================================
  // FFMPEG STITCH
  // ============================================
  console.log('🔧 Stitching frames with ffmpeg...');
  
  const preset = QUALITY === 'draft' ? 'fast' : 'slow';
  const crf = QUALITY === 'draft' ? '23' : '18';
  
  const ffmpegArgs = [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(FRAMES_DIR, 'frame_%06d.png'),
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', crf,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    FINAL_MP4
  ];

  await runCommand('ffmpeg', ffmpegArgs);
  console.log(`\n🎉 DONE! Output: ${FINAL_MP4}`);

  // Cleanup frames (optional)
  // fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    console.log(`🔧 Running: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on('error', err => reject(new Error(`${cmd} failed to start: ${err.message}`)));
  });
}

main().catch(err => {
  console.error('\n❌ Export failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});