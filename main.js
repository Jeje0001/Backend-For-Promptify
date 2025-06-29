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

const app = express()

// dotenv.config();
app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors()); // <-- enable preflight for all routes

// 2) Then parse JSON bodies
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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Upload directory for videos
const uploadDir = path.join(__dirname, 'uploads', 'videos');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Cuts directory for processed videos
const cutsDir = path.join(__dirname, 'uploads', 'cuts');
if (!fs.existsSync(cutsDir)) {
  fs.mkdirSync(cutsDir, { recursive: true });
}

const audioDir = path.join(__dirname, 'uploads', 'audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}
const subtitlesDir = path.join(__dirname, 'uploads', 'subtitles');
if (!fs.existsSync(subtitlesDir)) {
  fs.mkdirSync(subtitlesDir, { recursive: true });
}

// ============================
// Multer Configuration
// ============================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `video-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB limit
  fileFilter: (req, file, cb) => {
    const allowedExtensions = /mp4|mov|avi|mkv/;
    const allowedMimeTypes = /video\/.*/;
    const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedMimeTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'));
    }
  }
});

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
app.get('/', (req, res) => {
  res.send('Backend is running!');
});

/**
 * POST /api/upload
 * Handles video file uploads
 */
app.post('/api/upload', upload.single('video'), (req, res) => {
  // Validate file presence
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const fileUrl = `/uploads/videos/${req.file.filename}`;
  return res.status(200).json({
    success: true,
    filename: req.file.filename,
    url: fileUrl
  });
});

/**
 * POST /api/parse-prompt
 * Parses a user's prompt and returns structured editing commands
 */
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
    const uniqueSuffix = Date.now() + '-' + Math.floor(Math.random() * 1e9);
    const extension = path.extname(filename);
    const outputFilename = `cut-${uniqueSuffix}${extension}`;
    const outputFilePath = path.join(cutsDir, outputFilename);

    const command = `ffmpeg -i "${inputFilePath}" -ss ${resolvedStart} -to ${adjustedEnd} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k "${outputFilePath}"`;

    exec(command, (err) => {
      if (err) {
        console.error("FFmpeg error:", err);
        return res.status(500).json({ success: false, message: 'Failed to cut video.', error: err.message });
      }

      const fileUrl = `/uploads/cuts/${outputFilename}`;
      return res.status(200).json({
        success: true,
        message: 'Video cut successfully.',
        url: fileUrl
      });
    });
  });
});

/**
 * GET /force-download/:filename
 * Forces download of an output file by filename
 */
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
app.post('/api/slow-motion', async (req, res) => {
  const { filename, start, end, speed } = req.body;

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
      cmd: `ffmpeg -y -ss 0 -i "${inputPath}" -t ${sSec} -c copy "${partA}"`
    });
  }

  cmds.push({
    path: partB,
    cmd:
      `ffmpeg -y -ss ${sSec} -i "${inputPath}" -t ${origLen} ` +
      `-filter_complex "[0:v]setpts=${1 / sp}*PTS[v];[0:a]atempo=${sp}[a]" ` +
      `-map "[v]" -map "[a]" -t ${slowLen} "${partB}"`
  });

  if (partC) {
    cmds.push({
      path: partC,
      cmd: `ffmpeg -y -ss ${eSec} -i "${inputPath}" -c copy "${partC}"`
    });
  }

  // 7️⃣ Execute all commands
  try {
    for (const item of cmds) {
      await new Promise((ok, fail) => {
        exec(item.cmd, err => err ? fail(err) : ok());
      });
    }

    // 8️⃣ Write concat list
    const lines = cmds.map(i => `file '${i.path}'`).join('\n') + '\n';
    fs.writeFileSync(listTxt, lines);

    // 9️⃣ Concat parts into final output
    await new Promise((ok, fail) => {
      exec(
        `ffmpeg -y -f concat -safe 0 -i "${listTxt}" -c:v libx264 -preset fast -crf 23 -c:a aac "${outputFinal}"`,
        err => err ? fail(err) : ok()
      );
    });

    // 🔟 Cleanup
    cmds.forEach(i => fs.existsSync(i.path) && fs.unlinkSync(i.path));
    fs.unlinkSync(listTxt);

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
});

// ============================
// POST /api/extract-audio
// ============================
// Extracts audio from a video file as MP3 or WAV
app.post('/api/extract-audio', async (req, res) => {
  const { filename, format } = req.body;

  if (!filename) {
    return res.status(400).json({ success: false, message: "Missing filename" });
  }

  // Ensure download directory exists
  const downloadDir = path.join(__dirname, "downloads");
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
  }

  // Determine output format
  let outputFormat = "mp3";
  if (format) {
    const lowerFormat = format.toLowerCase();
    if (lowerFormat === "wav") {
      outputFormat = "wav";
    } else if (lowerFormat !== "mp3") {
      return res.status(400).json({ success: false, message: "Unsupported format" });
    }
  }

  const inputPath = path.join(__dirname, "uploads", "videos", filename);
  const baseName = path.parse(filename).name;
  const randomPart = Math.floor(Math.random() * 10000);
  const outputName = "audio-" + Date.now() + "-" + randomPart + "." + outputFormat;
  const outputPath = path.join(downloadDir, outputName);

  let ffmpegCommand = "";
  if (outputFormat === "mp3") {
    ffmpegCommand = `ffmpeg -i "${inputPath}" -vn -acodec libmp3lame "${outputPath}"`;
  } else {
    ffmpegCommand = `ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le "${outputPath}"`;
  }

  console.log("🎧 Extracting audio with command:", ffmpegCommand);

  exec(ffmpegCommand, (error, stdout, stderr) => {
    if (error) {
      console.error("❌ FFmpeg error:", stderr);
      return res.status(500).json({ success: false, message: "Audio extraction failed" });
    }

    return res.status(200).json({
      success: true,
      url: "/downloads/" + outputName
    });
  });
});



// ============================
// POST /api/add-subtitles
// ============================
// Extracts audio → transcribes with Whisper → burns subtitles into video
app.post('/api/add-subtitles', async (req, res) => {
  const { filename, user_id } = req.body;
  console.log("📝 Add subtitles requested by user:", user_id);

  // Input validation
  const invalidChars = ['..', '/', '\\'];
  for (let char of invalidChars) {
    if (filename.includes(char)) {
      return res.status(400).json({ success: false, message: 'Invalid filename' });
    }
  }

  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath) {
    return res.status(404).json({ success: false, message: 'Video file not found.' });
  }

  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
  const audioFilename = `${uniqueSuffix}.mp3`;
  const audioFilePath = path.join(audioDir, audioFilename);
  const srtFilename = `subtitles-${uniqueSuffix}.srt`;
  const srtFilePath = path.join(subtitlesDir, srtFilename);
  const ext = path.extname(filename);
  const outputFilename = `subtitled-${uniqueSuffix}${ext}`;
  const outputFilePath = path.join(cutsDir, outputFilename);

  // Step 1: Extract audio
  const extractCommand = `ffmpeg -i "${inputFilePath}" -vn -acodec libmp3lame -ar 44100 -ac 2 -ab 192k "${audioFilePath}"`;

  exec(extractCommand, async (error) => {
    if (error) {
      console.error("Audio extraction error:", error);
      return res.status(500).json({ success: false, message: 'Failed to extract audio.', error: error.message });
    }
    console.log("🎧 File exists:", fs.existsSync(audioFilePath));
    console.log("📁 Audio Path:", audioFilePath);


    try {
      // Step 2: Whisper transcription
      const transcription = await openai.audio.transcriptions.create({
        model: "whisper-1",
        file: fs.createReadStream(audioFilePath),
        response_format: "srt"
      });

      fs.writeFileSync(srtFilePath, transcription);

      // Step 3: Burn subtitles
      const burnCommand = `ffmpeg -i "${inputFilePath}" -vf subtitles="${srtFilePath}" -c:a copy "${outputFilePath}"`;

      exec(burnCommand, (burnErr) => {
        if (burnErr) {
          console.error("Subtitle burn error:", burnErr);
          return res.status(500).json({ success: false, message: 'Failed to burn subtitles.', error: burnErr.message });
        }

        // Optional: Clean up
        if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        if (fs.existsSync(srtFilePath)) fs.unlinkSync(srtFilePath);

        return res.status(200).json({
          success: true,
          message: 'Subtitles added and burned into video.',
          url: `/uploads/cuts/${outputFilename}`
        });
      });

    } catch (err) {
      console.error("Whisper error:", err);
      return res.status(500).json({ success: false, message: 'Failed to generate subtitles.', error: err.message });
    }
  });
});

app.post('/api/remove-segment', async (req, res) => {
  const { filename, start, end, user_id } = req.body;

  // 1. Validate input
  if (!filename || !start || !end) {
    return res.status(400).json({ success: false, message: 'Missing required fields: filename, start, and end.' });
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid filename.' });
  }

  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath) {
    return res.status(404).json({ success: false, message: 'Video file not found.' });
  }

  // 2. Normalize keywords
  let parsedStart = start === 'start' || start === 'beginning' ? '00:00:00' : start;
  let parsedEnd = end;

  // 3. Get video duration
  exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFilePath}"`, (err, stdout) => {
    if (err) {
      console.error('ffprobe error:', err);
      return res.status(500).json({ success: false, message: 'Failed to get video duration.', error: err.message });
    }

    const durationSeconds = parseFloat(stdout.trim());
    const endOfVideo = secondsToTime(durationSeconds);

    // 4. Expand 'end' or 'end-HH:MM:SS'
    const endExprRegex = /^end-(\d{2}):(\d{2}):(\d{2})$/;
    if (parsedEnd === 'end') {
      parsedEnd = endOfVideo;
    }
    if (endExprRegex.test(parsedStart)) {
      const [, hh, mm, ss] = parsedStart.match(endExprRegex);
      const offset = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
      parsedStart = secondsToTime(durationSeconds - offset);
    }
    if (endExprRegex.test(parsedEnd)) {
      const [, hh, mm, ss] = parsedEnd.match(endExprRegex);
      const offset = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
      parsedEnd = secondsToTime(durationSeconds - offset);
    }

    // 5. Validate format
    const timeRegex = /^([0-1]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
    if (!timeRegex.test(parsedStart) || !timeRegex.test(parsedEnd)) {
      return res.status(400).json({ success: false, message: 'Invalid time format. Use HH:MM:SS or end-relative format.' });
    }

    // 6. Sanity check
    const startSec = timeToSeconds(parsedStart);
    const endSec = timeToSeconds(parsedEnd);
    if (endSec <= startSec) {
      return res.status(400).json({ success: false, message: 'End time must be after start time.' });
    }

    // 7. Prepare paths and commands
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(filename);
    const partA = path.join(cutsDir, `keepA-${unique}${ext}`);
    const partB = path.join(cutsDir, `keepB-${unique}${ext}`);
    const listFile = path.join(cutsDir, `list-${unique}.txt`);
    const finalFile = `removed-${unique}${ext}`;
    const finalPath = path.join(cutsDir, finalFile);

    const cmds = [];

    if (startSec > 0) {
      cmds.push({
        path: partA,
        cmd: `ffmpeg -y -i "${inputFilePath}" -ss 00:00:00 -to ${parsedStart} -c copy "${partA}"`
      });
    }

    if (parsedEnd !== endOfVideo) {
      cmds.push({
        path: partB,
        cmd: `ffmpeg -y -i "${inputFilePath}" -ss ${parsedEnd} -to ${endOfVideo} -c copy "${partB}"`
      });
    }

    if (cmds.length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing left to keep. Aborting.' });
    }

    // 8. Run FFmpeg commands
    (async () => {
      try {
        for (const c of cmds) {
          await new Promise((resolve, reject) => {
            exec(c.cmd, err => err ? reject(err) : resolve());
          });
        }

        // 9. Write concat list
        const fileList = cmds.map(c => `file '${c.path}'`).join('\n');
        fs.writeFileSync(listFile, fileList);

        // 10. Concatenate
        exec(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -c:a aac "${finalPath}"`, (err) => {
          if (err) {
            console.error("Concat error:", err);
            return res.status(500).json({ success: false, message: 'Concat failed.', error: err.message });
          }

          // 11. Respond with new file
          return res.status(200).json({
            success: true,
            message: 'Segment removed.',
            url: `/uploads/cuts/${finalFile}`
          });
        });

      } catch (e) {
        console.error("Segment extraction error:", e);
        return res.status(500).json({ success: false, message: 'Processing failed.', error: e.message });
      }
    })();
  });

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


app.post('/api/export', (req, res) => {
  const { filename, targetFormat, newName, user_id } = req.body;

  // Step 1: Check if video exists
  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath) {
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
  let extension = 'mp4';
  if (targetFormat && typeof targetFormat === 'string') {
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

  // Step 5: Run FFmpeg
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stderr.on('data', (data) => {
    console.log(`📼 FFmpeg stderr: ${data}`);
  });

  ffmpeg.on('close', (code) => {
    if (code === 0) {
      console.log('✅ Export finished successfully');
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



            
