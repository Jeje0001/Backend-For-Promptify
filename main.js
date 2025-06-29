// ============================
// Imports & Setup
// ============================
// import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { PassThrough } from 'stream';
import { exec } from 'child_process';
import cors from 'cors';
import { spawn } from 'child_process';

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // use specific domain in production
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
app.use(express.json());


const port = process.env.PORT || 5001;


// ============================
// OpenAI Client
// ============================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============================
// Directory Setup
// ============================


// ============================
// Safe Paths Setup
// ============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const uploadDir = path.join(__dirname, 'uploads', 'videos');
const cutsDir = path.join(__dirname, 'uploads', 'cuts');
const audioDir = path.join(__dirname, 'uploads', 'audio');
const subtitlesDir = path.join(__dirname, 'uploads', 'subtitles');
const tempDir = path.join(__dirname, 'temp'); // for temporary work

[uploadDir, cutsDir, audioDir, subtitlesDir, tempDir].forEach(ensureDirExists);

// ============================
// Multer Storage Setup (Stream-based)
// ============================
const storage = multer.diskStorage({
  destination: (_, file, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const timestamp = Date.now();
    const unique = Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `video-${timestamp}-${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 250 * 1024 * 1024 // Drop to 250MB unless you NEED 500MB
  },
  fileFilter: (_, file, cb) => {
    const allowedExts = /\.(mp4|mov|avi|mkv)$/i;
    const allowedMime = /^video\//;
    const extOk = allowedExts.test(file.originalname);
    const mimeOk = allowedMime.test(file.mimetype);
    cb(null, extOk && mimeOk);
  }
});

export { uploadDir, cutsDir, audioDir, subtitlesDir, tempDir, upload };

// ============================
// Middleware
// ============================
app.use(express.json());
app.use('/uploads/videos', express.static(uploadDir));
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
app.use('/uploads/cuts', express.static(path.join(__dirname, 'uploads/cuts')));


// ============================
// Time Conversion Utilities
// ============================

/**
 * Converts a time string (HH:MM:SS) into total seconds.
 */
function timeToSeconds(time) {
  const [hours, minutes, seconds] = time.split(':').map(Number);
  return (hours * 3600) + (minutes * 60) + seconds;
}

/**
 * Converts a number of seconds into a time string (HH:MM:SS).
 */
function secondsToTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Resolves relative time expressions (like "start", "end", or "end-00:00:10") into HH:MM:SS.
 */
function resolveRelativeTime(timeStr, videoDuration) {
  if (timeStr === "start" || timeStr === "beginning") {
    return "00:00:00";
  }

  if (timeStr === "end") {
    return secondsToTime(videoDuration);
  }

  if (timeStr.startsWith("end-")) {
    const subtractStr = timeStr.replace("end-", "");
    const subtractSeconds = timeToSeconds(subtractStr);
    const adjustedSeconds = videoDuration - subtractSeconds;
    const safeSeconds = adjustedSeconds >= 0 ? adjustedSeconds : 0;
    return secondsToTime(safeSeconds);
  }

  return timeStr; // Already in HH:MM:SS
}

// ============================
// File/Video Utility
// ============================

/**
 * Checks common directories for the video file and returns the full path if found.
 */
function getVideoPath(filename) {
  const searchDirs = [uploadDir, cutsDir];
  for (const dir of searchDirs) {
    const fullPath = path.join(dir, filename);
    console.log("🔎 Checking:", fullPath);

    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  console.warn("❌ File not found:", filename);
  return null;
}

/**
 * Gets the duration of a video file in seconds using ffprobe.
 */
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;

    exec(cmd, (err, stdout) => {
      if (err) {
        return reject(err);
      }

      const duration = parseFloat(stdout.trim());
      resolve(duration);
    });
  });
}

// ============================
// Overlay Positioning
// ============================

/**
 * Returns the x and y coordinates based on a named position.
 */
function getPositionXY(position) {
  const positions = {
    "top-left": { x: 20, y: 20 },
    "top-center": { x: "(main_w-text_w)/2", y: 20 },
    "top-right": { x: "main_w-text_w-20", y: 20 },
    "bottom-left": { x: 20, y: "main_h-text_h-20" },
    "bottom-center": { x: "(main_w-text_w)/2", y: "main_h-text_h-20" },
    "bottom-right": { x: "main_w-text_w-20", y: "main_h-text_h-20" },
    "center": { x: "(main_w-text_w)/2", y: "(main_h-text_h)/2" }
  };

  if (positions[position]) {
    return positions[position];
  }

  return positions["center"];
}

/**
 * Generates the drawtext FFmpeg command from structured overlay data.
 */
function generateDrawtextCommand(data) {
  const { x, y } = getPositionXY(data.position);
  const start = data.start_time;
  const end = data.start_time === "END" ? "END" : start + data.duration;
  const fontsize = data.fontsize || 36;
  const fontFile = data.bold
    ? ":fontfile=/System/Library/Fonts/Supplemental/Arial Bold.ttf"
    : "";

  const drawtext = `drawtext=text='${data.text}':x=${x}:y=${y}:fontsize=${fontsize}:fontcolor=${data.color}${fontFile}:enable='between(t,${start},${end})'`;
  console.log("🎬 FFmpeg drawtext command:", drawtext);

  return drawtext;
}

// ============================
// Prompt Parsing for Overlays
// ============================

/**
 * Parses a natural language overlay prompt into structured overlay command data.
 */
function parseOverlayPrompt(prompt) {
  const result = {
    text: '',
    start_time: 0,
    duration: 3,
    color: 'white',
    position: 'center',
    bold: false,
    fontsize: 64
  };

  // Font size
  const fontSizeMap = {
    "small": 24,
    "medium": 36,
    "large": 48,
    "big": 48,
    "huge": 60,
    "extra large": 80
  };
  const fontSizeMatch = prompt.match(/(extra large|huge|big|large|medium|small)/i);
  if (fontSizeMatch) {
    const sizeKey = fontSizeMatch[1].toLowerCase();
    result.fontsize = fontSizeMap[sizeKey];
  }

  // Extract quoted or fallback text
  const quoteMatch = prompt.match(/['"](.+?)['"]/);
  const rawTextMatch = prompt.match(/(?:add|put)\s+([a-zA-Z0-9!?,.' ]+)/i);
  if (quoteMatch) {
    result.text = quoteMatch[1];
  } else if (rawTextMatch) {
    result.text = rawTextMatch[1];
  } else {
    result.text = 'Text';
  }

  // Time extraction
  const timeMatch = prompt.match(/(?:at|minute)\s*(\d{1,2}):?(\d{2})?/i);
  const endMatch = /at (the end|end of the video)/i.test(prompt);
  const startMatch = /at (the start|start of the video)/i.test(prompt);

  if (timeMatch) {
    const minutes = parseInt(timeMatch[1]) || 0;
    const seconds = parseInt(timeMatch[2]) || 0;
    result.start_time = (minutes * 60) + seconds;
  } else if (endMatch) {
    result.start_time = "END";
  } else if (startMatch) {
    result.start_time = 0;
  }

  // Duration
  const durationMatch = prompt.match(/for (\d+) seconds/);
  if (durationMatch) {
    result.duration = parseInt(durationMatch[1]);
  }

  // Color
  const knownColors = ['red', 'blue', 'green', 'white', 'black', 'yellow', 'purple', 'orange', 'pink', 'gray'];
  const colorMatch = prompt.match(/in (\w+)/i);
  if (colorMatch) {
    const potentialColor = colorMatch[1].toLowerCase();
    if (knownColors.includes(potentialColor)) {
      result.color = potentialColor;
    }
  }

  // Position
  const posMatch = prompt.match(/(top-left|top-right|top-center|bottom-left|bottom-right|bottom-center|center)/i);
  if (posMatch) {
    result.position = posMatch[1].toLowerCase();
  } else {
    if (/top/i.test(prompt)) result.position = "top-center";
    if (/bottom/i.test(prompt)) result.position = "bottom-center";
    if (/left/i.test(prompt)) result.position = "top-left";
    if (/right/i.test(prompt)) result.position = "top-right";
  }

  // Bold
  if (/bold/i.test(prompt)) {
    result.bold = true;
  }

  // Normalize aliases like "left" → "top-left"
  if (result.position === "right") result.position = "top-right";
  if (result.position === "left") result.position = "top-left";
  if (result.position === "bottom") result.position = "bottom-center";
  if (result.position === "top") result.position = "top-center";

  console.log("🧠 Parsed Overlay:", result);
  return result;
}

// ============================
// Misc Utilities
// ============================

/**
 * Parses expressions like "end-00:00:05" and returns the resolved time in seconds.
 */
function parseEndExpression(expression, durationSeconds) {
  if (!expression) return null;

  if (expression === 'end') {
    return durationSeconds;
  }

  const match = expression.match(/^end-(\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const hh = parseInt(match[1], 10);
    const mm = parseInt(match[2], 10);
    const ss = parseInt(match[3], 10);
    const offset = (hh * 3600) + (mm * 60) + ss;
    return durationSeconds - offset;
  }

  return expression; // fallback
}


// ============================
// ROUTES
// ============================

/**
 * GET /
 * Health check endpoint
 */
console.log('Defining route: /');
app.get('/', (_, res) => {
  res.send('Backend is running!');
});

// ============================
// POST /api/upload
// ============================
console.log('Defining route: /api/upload');
app.post('/api/upload', upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No video file uploaded.' });
    }

    const videoPath = path.join('/uploads/videos', req.file.filename); // Relative path for frontend
    return res.status(200).json({
      success: true,
      filename: req.file.filename,
      url: videoPath
    });

  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ success: false, message: 'Server error during upload.' });
  }
});

/**
 * POST /api/parse-prompt
 * Parses a user's prompt and returns structured editing commands
 */
console.log('Defining route: /api/parse-prompt');
app.post('/api/parse-prompt', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ success: false, message: 'No prompt provided' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",

         content: `
                    You are a strict parser for a video-editing CLI. Output pure JSON only.

                    ---

                    Available actions:
                    • cut — extract only the given segment
                    • remove_segment — delete the given segment
                    • add_subtitles — add subtitles
                    • export — export video
                    • undo — undo the last edit
                    • add_overlay — overlay text on the video
                    • extract_audio — extract audio as .mp3 or .wav
                    • slow_motion — apply slow motion to a part of the video

                    ---

                    Timestamps must be full HH:MM:SS or keywords:
                    • "start" or "beginning" → 00:00:00
                    • "end" → end of video
                    • "end-00:00:10" → 10 seconds before the end

                    ---

                    Rules:
                    - If the prompt says “remove” or “delete”, use "remove_segment"
                    - If it says “cut”, “clip”, or “extract”, use "cut"
                    - If the user says undo or reverse, return { "action": "undo" }
                    - If the user says redo or do again, return { "action": "redo" }
                    - Always respond with pure JSON: { "actions": [ { ... } ] }
                    - If the prompt says “Add 'text'...” or “Put 'text'...” (e.g., “Add 'Subscribe Now' at the end”), use action "add_overlay"
                    - For overlays, return: 
                      {
                        "action": "add_overlay",
                        "prompt": "[the full prompt text]"
                      }
                    - If the prompt includes "extract audio" or "convert to mp3/wav", use "extract_audio"
                    - Default format is "mp3" unless user says "wav"
                    - Return: { "action": "extract_audio", "format": "mp3" }
                    - If the prompt says “slow motion” or “slow down”, use "slow_motion"
                  - Default speed = 0.5 unless otherwise specified
                  - Examples:
                    - “Slow motion from 3:00 to 3:30”
                      → { "action": "slow_motion", "start": "00:03:00", "end": "00:03:30", "speed": 0.5 }

                    - “Add slow motion from the beginning to 0:30”
                      → { "action": "slow_motion", "start": "start", "end": "00:00:30", "speed": 0.5 }

                    - “Apply slow motion from 0:40 till the end”
                      → { "action": "slow_motion", "start": "00:00:40", "end": "end", "speed": 0.5 }

                    - “Make 1:10 to 1:20 2x slower”
                      → { "action": "slow_motion", "start": "00:01:10", "end": "00:01:20", "speed": 0.5 }

                    - “Slow down clip from 2:00 to 2:30 to 25% speed”
                      → { "action": "slow_motion", "start": "00:02:00", "end": "00:02:30", "speed": 0.25 }
                    
                      - If the user says "slow down the whole video" or "make entire video slower", return:
                          {
                            "action": "slow_motion",
                            "start": "start",
                            "end": "end",
                            "speed": 0.5
                          }
                       - If a speed like "25% speed" or "make it 2x slower" is mentioned, calculate the speed:
                            - "2x slower" → 0.5
                            - "half speed" → 0.5
                            - "quarter speed" → 0.25
                            - "75% speed" → 0.75
                    ---

                    Examples:
                    - “Remove the last 5 seconds”  
                      → { "actions": [ { "action": "remove_segment", "start": "end-00:00:05", "end": "end" } ] }

                    - “Cut the last 10 seconds”  
                      → { "actions": [ { "action": "cut", "start": "end-00:00:10", "end": "end" } ] }

                    - “Trim the first 10 seconds”  
                      → { "actions": [ { "action": "remove_segment", "start": "00:00:00", "end": "00:00:10" } ] }

                    - “Undo that”  
                      → { "actions": [ { "action": "undo" } ] }

                    - “Add 'Subscribe Now' at the end in red top-right bold text”
                        → { "actions": [ { "action": "add_overlay", "prompt": "Add 'Subscribe Now' at the end in red top-right bold text" } ] }

               
                    `
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    let gptResponse = completion.choices[0].message.content;
    console.log("GPT Response:", gptResponse);

    // Remove markdown formatting if any
    gptResponse = gptResponse.replace(/```json/g, '').replace(/```/g, '').trim();

    const parsed = JSON.parse(gptResponse);
    const actions = parsed.actions;

    const supportedActions = [
      'cut', 'trim', 'add_subtitles', 'export',
      'remove_segment', 'undo', 'add_overlay',
      'extract_audio', 'slow_motion'
    ];

    for (const act of actions) {
      if (!supportedActions.includes(act.action)) {
        return res.status(400).json({
          success: false,
          message: `The requested action '${act.action}' is not currently supported.`
        });
      }
    }

    return res.status(200).json({ success: true, actions });

  } catch (error) {
    console.error("Error parsing prompt:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to parse prompt",
      error: error.message
    });
  }
});

/**
 * POST /api/cut-video
 * Cuts a segment from the video between start and end times
 */
console.log('Defining route: /api/cut-video');
app.post('/api/cut-video', async (req, res) => {
  const { filename, start, end } = req.body;

  // Validate input presence
  if (!filename || !start || !end) {
    return res.status(400).json({ success: false, message: 'Missing required fields: filename, start, and end.' });
  }

  // Sanitize filename
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return res.status(400).json({ success: false, message: 'Invalid filename.' });
  }

  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath) {
    return res.status(404).json({ success: false, message: 'Video file not found.' });
  }

  // Run ffprobe to get duration
  exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFilePath}"`, (error, stdout) => {
    if (error) {
      console.error("ffprobe error:", error);
      return res.status(500).json({ success: false, message: 'Failed to analyze video duration.', error: error.message });
    }

    const videoDuration = parseFloat(stdout);
    const resolvedStart = resolveRelativeTime(start, videoDuration);
    const resolvedEnd = resolveRelativeTime(end, videoDuration);

    // Ensure valid time formats
    const timeFormatRegex = /^([0-1]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
    if (!timeFormatRegex.test(resolvedStart) || !timeFormatRegex.test(resolvedEnd)) {
      return res.status(400).json({ success: false, message: 'Invalid time format. Use HH:MM:SS.' });
    }

    const startSeconds = timeToSeconds(resolvedStart);
    const endSeconds = timeToSeconds(resolvedEnd);

    if (endSeconds <= startSeconds) {
      return res.status(400).json({ success: false, message: 'End time must be after start time.' });
    }

    let adjustedEnd = resolvedEnd;
    if (endSeconds > videoDuration) {
      adjustedEnd = secondsToTime(videoDuration);
    }

    // Build FFmpeg cut command
            const ffmpeg = spawn('ffmpeg', [
          '-i', inputFilePath,
          '-ss', resolvedStart,
          '-to', adjustedEnd,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-y', // Overwrite if file exists
          outputFilePath
        ]);
        
        ffmpeg.stderr.on('data', (data) => {
          console.log(`ffmpeg stderr: ${data}`);
        });
        
        ffmpeg.on('close', (code) => {
          if (code === 0) {
            const fileUrl = `/uploads/cuts/${outputFilename}`;
            return res.status(200).json({
              success: true,
              message: 'Video cut successfully.',
              url: fileUrl
            });
          } else {
            return res.status(500).json({ success: false, message: 'Video cut failed.', code });
          }
        });

  });
});

/**
 * GET /force-download/:filename
 * Forces download of an output file by filename
 */
console.log('Defining route: /api/force-download');
app.get('/force-download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'downloads', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  return res.download(filePath); // Triggers browser download
});


// ============================
// POST /api/add-overlay
// ============================
// Adds overlay text to a video based on natural language prompt.
console.log('Defining route: /api/add-overlay');
app.post('/api/add-overlay', async (req, res) => {
  const { prompt, filename } = req.body;

  // ❌ Reject if required fields are missing or unsafe
  if (!prompt || !filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid prompt or filename.' });
  }

  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath) {
    return res.status(404).json({ success: false, message: 'Video file not found.' });
  }

  const overlayData = parseOverlayPrompt(prompt);

  // 🕒 If 'END' is used, calculate actual start time based on video duration
  if (overlayData.start_time === 'END') {
    try {
      const durationSeconds = await getVideoDuration(inputFilePath);
      overlayData.start_time = Math.floor(durationSeconds - overlayData.duration);
    } catch (err) {
      console.error("Failed to get duration:", err);
      return res.status(500).json({ success: false, message: 'Failed to get video duration.', error: err.message });
    }
  }

  const drawtextCommand = generateDrawtextCommand(overlayData);
  const outputFilename = `overlay-${Date.now()}-${Math.floor(Math.random() * 1e9)}${path.extname(filename)}`;
  const outputFilePath = path.join(cutsDir, outputFilename);

  const ffmpegArgs = [
    '-y', '-i', inputFilePath,
    '-vf', drawtextCommand,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'copy',
    outputFilePath
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stderr.on('data', data => {
    console.log(`📼 FFmpeg stderr: ${data}`);
  });

  ffmpeg.on('close', code => {
    if (code === 0) {
    fs.unlink(inputFilePath, (err) => {
        if (err) console.error("Cleanup error:", err);
      });
      return res.status(200).json({
        success: true,
        message: 'Overlay added.',
        url: `/uploads/cuts/${outputFilename}`
      });
    
    } else {
      return res.status(500).json({ success: false, message: 'Overlay failed.', code });
    }
  });

  ffmpeg.on('error', err => {
    return res.status(500).json({ success: false, message: 'Failed to start FFmpeg.', error: err.message });
  });
});




// ============================
// POST /api/slow-motion
// ============================
// Applies slow motion to a video segment
console.log('Defining route: /api/slow-motion');
app.post('/api/slow-motion', async (req, res) => {
  const { filename, start, end, speed } = req.body;
  const TIMEOUT_MS = 120000;


  // 1️⃣ Validate input
  if (!filename || !start || !end || !speed) {
    return res.status(400).json({ success: false, message: 'Missing filename, start, end or speed.' });
  }

  const inputPath = getVideoPath(filename);
  if (!inputPath) {
    return res.status(404).json({ success: false, message: 'Video not found.' });
  }

  // 2️⃣ Get video duration
  let fullDur;
  try {
    fullDur = await getVideoDuration(inputPath);
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Could not probe duration.' });
  }

  // 3️⃣ Normalize start/end
  const normalizeTime = (t) => {
    if (t === 'start') return '00:00:00';
    if (t === 'end') return secondsToTime(fullDur);
    if (t.startsWith('end-')) {
      const subtract = timeToSeconds(t.replace('end-', ''));
      return secondsToTime(Math.max(0, fullDur - subtract));
    }
    return t;
  };

  const sHH = normalizeTime(start);
  const eHH = normalizeTime(end);
  const sSec = timeToSeconds(sHH);
  const eSec = timeToSeconds(eHH);

  if (sSec >= eSec || eSec > fullDur) {
    return res.status(400).json({ success: false, message: 'Invalid time range.' });
  }

  // 4️⃣ Parse and validate speed
  const sp = parseFloat(speed);
  if (isNaN(sp) || sp <= 0 || sp > 5) {
    return res.status(400).json({ success: false, message: 'Speed must be between 0.1 and 5.' });
  }

  const origLen = eSec - sSec;
  const slowLen = origLen / sp;

  // 5️⃣ Setup output paths
  const ext = path.extname(filename);
  const uid = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const partA = start === 'start' ? null : path.join(cutsDir, `pre-${uid}${ext}`);
  const partB = path.join(cutsDir, `slow-${uid}${ext}`);
  const partC = end === 'end' ? null : path.join(cutsDir, `post-${uid}${ext}`);
  const listTxt = path.join(cutsDir, `list-${uid}.txt`);
  const outputFinal = path.join(cutsDir, `slowmo-${uid}${ext}`);

  // 6️⃣ Build FFmpeg commands
  
  const cmds = [];

  if (partA) {
    cmds.push({
      path: partA,
      args: ['-nostdin', '-threads', '1', '-ss', '0', '-i', inputPath, '-t', `${sSec}`, '-c', 'copy', partA]
    });
  }

  cmds.push({
    path: partB,
    args: [
      '-nostdin', '-threads', '1',
      '-ss', `${sSec}`, '-i', inputPath, '-t', `${origLen}`,
      '-filter_complex', `[0:v]setpts=${1 / sp}*PTS[v];[0:a]atempo=${sp}[a]`,
      '-map', '[v]', '-map', '[a]', '-t', `${slowLen}`, partB
    ]
  });

  if (partC) {
    cmds.push({
      path: partC,
      args: ['-nostdin', '-threads', '1', '-ss', `${eSec}`, '-i', inputPath, '-c', 'copy', partC]
    });
  }


  // 7️⃣ Execute all commands

  try {
    for (const { args } of cmds) {
      await runFFmpeg(args, TIMEOUT_MS);
    }

    const concatList = cmds.map(i => `file '${i.path}'`).join('\n');
    fs.writeFileSync(listTxt, concatList);

    await runFFmpeg([
      '-nostdin', '-threads', '1',
      '-f', 'concat', '-safe', '0', '-i', listTxt,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', outputFinal
    ], TIMEOUT_MS);

    cmds.forEach(({ path }) => fs.existsSync(path) && fs.unlinkSync(path));
    fs.existsSync(listTxt) && fs.unlinkSync(listTxt);
    fs.unlinkSync(inputPath); // 🔥 Delete uploaded video after processing

    return res.json({ success: true, url: `/uploads/cuts/${path.basename(outputFinal)}` });

  } catch (err) {
    console.error('💥 Slow-motion failed:', err);
    return res.status(500).json({ success: false, message: 'Processing failed.', error: err.message });
  }

  // 🔧 Local Helpers
  function timeToSeconds(ts) {
    const [H, M, S] = ts.split(':').map(Number);
    return H * 3600 + M * 60 + S;
  }

  function secondsToTime(sec) {
    const H = Math.floor(sec / 3600).toString().padStart(2, '0');
    const M = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
    const S = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${H}:${M}:${S}`;
  }
    function runFFmpeg(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      const timeout = setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        reject(new Error('FFmpeg timed out'));
      }, timeoutMs);

      ffmpeg.on('close', code => {
        clearTimeout(timeout);
        return code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`));
      });

      ffmpeg.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
});


// ============================
// POST /api/extract-audio
// ============================
// Extracts audio from a video file as MP3 or WAV
app.post('/api/extract-audio', async (req, res) => {
  const { filename, format } = req.body;
  const TIMEOUT_MS = 60000;

  if (!filename) {
    return res.status(400).json({ success: false, message: "Missing filename" });
  }

  const inputPath = path.join(__dirname, "uploads", "videos", filename);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ success: false, message: "Video file not found." });
  }

  const downloadDir = path.join(__dirname, "downloads");
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
  }

  let outputFormat = "mp3";
  if (format && format.toLowerCase() === "wav") {
    outputFormat = "wav";
  } else if (format && format.toLowerCase() !== "mp3") {
    return res.status(400).json({ success: false, message: "Unsupported format" });
  }

  const randomSuffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const outputName = `audio-${randomSuffix}.${outputFormat}`;
  const outputPath = path.join(downloadDir, outputName);

  const args = [
    '-nostdin', '-threads', '1',
    '-i', inputPath,
    '-vn',
    '-acodec', outputFormat === "mp3" ? 'libmp3lame' : 'pcm_s16le',
    outputPath
  ];

  try {
    await runFFmpeg(args, TIMEOUT_MS);
    return res.status(200).json({ success: true, url: "/downloads/" + outputName });
  } catch (err) {
    console.error("❌ Audio extraction error:", err.message);
    return res.status(500).json({ success: false, message: "Audio extraction failed", error: err.message });
  }

  function runFFmpeg(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      const timeout = setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        reject(new Error('FFmpeg timed out'));
      }, timeoutMs);

      ffmpeg.on('close', code => {
        clearTimeout(timeout);
        return code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`));
      });

      ffmpeg.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
});



// ============================
// POST /api/add-subtitles
// ============================
// Extracts audio → transcribes with Whisper → burns subtitles into video
console.log('Defining route: /api/add-subtitlies');
app.post('/api/add-subtitles', async (req, res) => {
  const { filename, user_id } = req.body;
  const TIMEOUT_MS = 120000;
  console.log("📝 Add subtitles requested by user:", user_id);

  // Validate input
  if (!filename || ['..', '/', '\\'].some(c => filename.includes(c))) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }

  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath || !fs.existsSync(inputFilePath)) {
    return res.status(404).json({ success: false, message: 'Video file not found.' });
  }

  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const audioFilename = `${uniqueSuffix}.mp3`;
  const audioFilePath = path.join(audioDir, audioFilename);
  const srtFilename = `subtitles-${uniqueSuffix}.srt`;
  const srtFilePath = path.join(subtitlesDir, srtFilename);
  const ext = path.extname(filename);
  const outputFilename = `subtitled-${uniqueSuffix}${ext}`;
  const outputFilePath = path.join(cutsDir, outputFilename);

  try {
    // Step 1: Extract audio
    await runFFmpeg([
      '-nostdin', '-threads', '1',
      '-i', inputFilePath,
      '-vn', '-acodec', 'libmp3lame', '-ar', '44100', '-ac', '2', '-ab', '192k',
      audioFilePath
    ], TIMEOUT_MS);

    // Step 2: Whisper transcription
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(audioFilePath),
      response_format: "srt"
    });

    fs.writeFileSync(srtFilePath, transcription);

    // Step 3: Burn subtitles
    await runFFmpeg([
      '-nostdin', '-threads', '1',
      '-i', inputFilePath,
      '-vf', `subtitles=${srtFilePath}`,
      '-c:a', 'copy',
      outputFilePath
    ], TIMEOUT_MS);

    // Cleanup
    if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    if (fs.existsSync(srtFilePath)) fs.unlinkSync(srtFilePath);
    fs.unlinkSync(inputFilePath); // optional: remove original video to save space

    return res.status(200).json({
      success: true,
      message: 'Subtitles added and burned into video.',
      url: `/uploads/cuts/${outputFilename}`
    });

  } catch (err) {
    console.error("🔥 Subtitle process failed:", err.message);
    return res.status(500).json({ success: false, message: 'Subtitle generation failed.', error: err.message });
  }

  function runFFmpeg(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      const timeout = setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        reject(new Error('FFmpeg timed out'));
      }, timeoutMs);

      ffmpeg.on('close', code => {
        clearTimeout(timeout);
        return code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`));
      });

      ffmpeg.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
});

console.log('Defining route: /api/remove-segment');
app.post('/api/remove-segment', async (req, res) => {
  const { filename, start, end, user_id } = req.body;
  const TIMEOUT_MS = 120000;

  // 1️⃣ Validate input
  if (!filename || !start || !end) {
    return res.status(400).json({ success: false, message: 'Missing required fields: filename, start, and end.' });
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid filename.' });
  }

  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath || !fs.existsSync(inputFilePath)) {
    return res.status(404).json({ success: false, message: 'Video file not found.' });
  }

  // 2️⃣ Normalize 'start', 'end', and relative expressions
  let parsedStart = start === 'start' || start === 'beginning' ? '00:00:00' : start;
  let parsedEnd = end;

  try {
    const durationSec = await getDuration(inputFilePath);
    const endOfVideo = secondsToTime(durationSec);

    const endExpr = /^end-(\d{2}):(\d{2}):(\d{2})$/;

    if (parsedEnd === 'end') parsedEnd = endOfVideo;
    if (endExpr.test(parsedStart)) {
      const [_, hh, mm, ss] = parsedStart.match(endExpr);
      const offset = (+hh) * 3600 + (+mm) * 60 + (+ss);
      parsedStart = secondsToTime(Math.max(0, durationSec - offset));
    }
    if (endExpr.test(parsedEnd)) {
      const [_, hh, mm, ss] = parsedEnd.match(endExpr);
      const offset = (+hh) * 3600 + (+mm) * 60 + (+ss);
      parsedEnd = secondsToTime(Math.max(0, durationSec - offset));
    }

    // 3️⃣ Validate times
    const timeRegex = /^([0-1]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
    if (!timeRegex.test(parsedStart) || !timeRegex.test(parsedEnd)) {
      return res.status(400).json({ success: false, message: 'Invalid time format. Use HH:MM:SS or end-relative format.' });
    }

    const startSec = timeToSeconds(parsedStart);
    const endSec = timeToSeconds(parsedEnd);

    if (endSec <= startSec) {
      return res.status(400).json({ success: false, message: 'End time must be after start time.' });
    }

    // 4️⃣ Prepare paths
    const uid = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ext = path.extname(filename);
    const partA = startSec > 0 ? path.join(cutsDir, `keepA-${uid}${ext}`) : null;
    const partB = parsedEnd !== endOfVideo ? path.join(cutsDir, `keepB-${uid}${ext}`) : null;
    const listFile = path.join(cutsDir, `list-${uid}.txt`);
    const finalName = `removed-${uid}${ext}`;
    const finalPath = path.join(cutsDir, finalName);

    // 5️⃣ Run FFmpeg cuts
    if (partA) {
      await runFFmpeg(['-y', '-i', inputFilePath, '-ss', '00:00:00', '-to', parsedStart, '-c', 'copy', partA], TIMEOUT_MS);
    }

    if (partB) {
      await runFFmpeg(['-y', '-i', inputFilePath, '-ss', parsedEnd, '-to', endOfVideo, '-c', 'copy', partB], TIMEOUT_MS);
    }

    // 6️⃣ Write concat list
    const filesToConcat = [partA, partB].filter(Boolean);
    if (filesToConcat.length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing left to keep. Aborting.' });
    }

    fs.writeFileSync(listFile, filesToConcat.map(p => `file '${p}'`).join('\n'));

    // 7️⃣ Concatenate
    await runFFmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
      finalPath
    ], TIMEOUT_MS);

    // 8️⃣ Cleanup
    [partA, partB, listFile, inputFilePath].forEach(p => {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    });

    return res.status(200).json({
      success: true,
      message: 'Segment removed successfully.',
      url: `/uploads/cuts/${finalName}`
    });

  } catch (err) {
    console.error("❌ Segment removal error:", err);
    return res.status(500).json({ success: false, message: 'Internal error during segment removal.', error: err.message });
  }

  // ⏱ Helper: get duration using ffprobe
  function getDuration(filepath) {
    return new Promise((resolve, reject) => {
      const cmd = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filepath]);
      let output = '';
      cmd.stdout.on('data', chunk => output += chunk);
      cmd.on('close', () => resolve(parseFloat(output.trim())));
      cmd.on('error', reject);
    });
  }

  // ⏱ Helper: run ffmpeg safely
  function runFFmpeg(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args);
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('FFmpeg timed out'));
      }, timeoutMs);

      proc.on('close', code => {
        clearTimeout(timeout);
        return code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`));
      });

      proc.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // ⏱ Time conversions
  function timeToSeconds(str) {
    const [h, m, s] = str.split(':').map(Number);
    return h * 3600 + m * 60 + s;
  }

  function secondsToTime(secs) {
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(secs % 60)).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }
});


console.log('Defining route: /api/export');
app.post('/api/export', (req, res) => {
  const { filename, targetFormat, newName, user_id } = req.body;

  // Step 1: Check if video exists
  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath || !fs.existsSync(inputFilePath)) {
    return res.status(404).json({
      success: false,
      message: 'Video file not found.'
    });
  }

  // Step 2: Determine base filename
  let baseName = `exported-${Date.now()}`;
  if (newName && typeof newName === 'string') {
    baseName = newName.replace(/\s+/g, '_');
  }

  // Step 3: Determine export format
  const allowedFormats = ['mp4', 'mov', 'avi', 'webm', 'mkv'];
  let extension = 'mp4';
  if (targetFormat && typeof targetFormat === 'string' && allowedFormats.includes(targetFormat)) {
    extension = targetFormat;
  }

  const outputFilename = `${baseName}.${extension}`;
  const outputPath = path.join(cutsDir, outputFilename);

  // Step 4: FFmpeg arguments
  const ffmpegArgs = [
    '-y',
    '-i', inputFilePath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath
  ];

  console.log("🚀 Spawning FFmpeg with args:", ffmpegArgs.join(' '));

  // Step 5: Run FFmpeg with optional timeout
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

  const timeout = setTimeout(() => {
    ffmpeg.kill('SIGKILL');
    console.error('❌ FFmpeg process killed due to timeout.');
  }, TIMEOUT_MS);

  ffmpeg.stderr.on('data', (data) => {
    console.log(`📼 FFmpeg stderr: ${data}`);
  });

  ffmpeg.on('close', (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      console.log('✅ Export finished successfully');

      // Optional: delete original file after export
      // fs.unlinkSync(inputFilePath);

      return res.status(200).json({
        success: true,
        message: 'Export complete.',
        url: `/uploads/cuts/${outputFilename}`
      });
    }

    console.error('❌ FFmpeg exited with code:', code);
    return res.status(500).json({
      success: false,
      message: 'Export failed.',
      code: code
    });
  });

  ffmpeg.on('error', (err) => {
    clearTimeout(timeout);
    console.error('🚨 FFmpeg spawn error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to start FFmpeg.',
      error: err.message
    });
  });
});


// ============================
// Start Server
// ============================
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});



            
