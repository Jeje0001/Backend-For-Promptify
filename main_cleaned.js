
// ============================
// Imports & Setup
// ============================
import dotenv from 'dotenv';
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


dotenv.config();

const app = express();
const port = 5001;
app.use(cors());

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
// Helper Functions
// ============================

// Converts time string (HH:MM:SS) to seconds
function timeToSeconds(time) {
  const [hours, minutes, seconds] = time.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}
function resolveRelativeTime(timeStr, videoDuration) {
  if (timeStr === "start" || timeStr === "beginning") return "00:00:00";
  if (timeStr === "end") return secondsToTime(videoDuration);

  // e.g. end-00:00:10 → subtract 10s from duration
  if (timeStr.startsWith("end-")) {
    const subtractStr = timeStr.replace("end-", "");
    const subtractSeconds = timeToSeconds(subtractStr);
    const resultSeconds = Math.max(0, videoDuration - subtractSeconds);
    return secondsToTime(resultSeconds);
  }

  return timeStr; // assume it's already HH:MM:SS
}



// Converts seconds to time string (HH:MM:SS)
function secondsToTime(sec) {
  const h = Math.floor(sec / 3600).toString().padStart(2, "0");
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function getVideoPath(filename) {
  const baseDirs = [uploadDir, cutsDir];
  for (const dir of baseDirs) {
    const fullPath = path.join(dir, filename);
    console.log("🔎 Checking:", fullPath);

    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  console.warn("❌ File not found:", filename);

  return null;
}
const getVideoDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    exec(cmd, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseFloat(stdout.trim()));
    });
  });
};
// === Utility: getPositionXY ===
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

  return positions[position] || positions["center"];
}

// === Utility: generateDrawtextCommand ===
function generateDrawtextCommand(data) {
  const { x, y } = getPositionXY(data.position);

  let endTime;
  if (data.start_time === "END") {
    endTime = "END"; // Will be resolved before FFmpeg is run
  } else {
    endTime = data.start_time + data.duration;
  }

  const fontsize = data.fontsize || 36;

  let fontFile = "";
  if (data.bold) {
    fontFile = ":fontfile=/System/Library/Fonts/Supplemental/Arial Bold.ttf"; // Use your desired font path
  }

  const drawtext = `drawtext=text='${data.text}':x=${x}:y=${y}:fontsize=${data.fontsize}:fontcolor=${data.color}${fontFile}:enable='between(t,${data.start_time},${endTime})'`;
  console.log("🎬 FFmpeg drawtext command:", drawtext);

  return drawtext;
}

// === Utility: parseOverlayPrompt ===
function parseOverlayPrompt(prompt) {
  const result = {
    text: '',
    start_time: 0,
    duration: 3,
    color: 'white',
    position: 'center',
    bold: false,
    fontsize:64
  };
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


  const quoteMatch = prompt.match(/['"](.+?)['"]/);
  const rawTextMatch = prompt.match(/(?:add|put)\s+([a-zA-Z0-9!?,.' ]+)/i);
  result.text = quoteMatch?.[1] || rawTextMatch?.[1] || 'Text';

  const timeMatch = prompt.match(/(?:at|minute)\s*(\d{1,2}):?(\d{2})?/i);
  const endMatch = /at (the end|end of the video)/i.test(prompt);
  const startMatch = /at (the start|start of the video)/i.test(prompt);

  if (timeMatch) {
    const minutes = parseInt(timeMatch[1] || 0);
    const seconds = parseInt(timeMatch[2] || 0);
    result.start_time = minutes * 60 + seconds;
  } else if (endMatch) {
    result.start_time = "END";
  } else if (startMatch) {
    result.start_time = 0;
  }

  const durationMatch = prompt.match(/for (\d+) seconds/);
  if (durationMatch) {
    result.duration = parseInt(durationMatch[1]);
  }

  const knownColors = ['red', 'blue', 'green', 'white', 'black', 'yellow', 'purple', 'orange', 'pink', 'gray'];
const colorMatch = prompt.match(/in (\w+)/i);
if (colorMatch) {
  const possibleColor = colorMatch[1].toLowerCase();
  if (knownColors.includes(possibleColor)) {
    result.color = possibleColor;
  }
}


  const posMatch = prompt.match(/(top-left|top-right|top-center|bottom-left|bottom-right|bottom-center|center)/i);
  if (posMatch) {
  result.position = posMatch[1].toLowerCase();
} else {
  if (/top/i.test(prompt)) result.position = "top-center";
  if (/bottom/i.test(prompt)) result.position = "bottom-center";
  if (/left/i.test(prompt)) result.position = "top-left";
  if (/right/i.test(prompt)) result.position = "top-right";
}


  result.bold = /bold/i.test(prompt);
  if (result.position === "right") result.position = "top-right";
  if (result.position === "left") result.position = "top-left";
  if (result.position === "bottom") result.position = "bottom-center";
  if (result.position === "top") result.position = "top-center";
  console.log("🧠 Parsed Overlay:", result);
  console.log("📍 Final overlay position:", result.position);

  return result;
}




const parseEndExpression = (expression, durationSeconds) => {
  if (!expression) return null;

  if (expression === 'end') {
    return durationSeconds;
  }

  const match = expression.match(/^end-(\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [, hh, mm, ss] = match.map(Number);
    const offset = hh * 3600 + mm * 60 + ss;
    return durationSeconds - offset;
  }

  // fallback: return standard time string
  return expression;
};

// ============================
// Routes
// ============================

// Health Check Route
app.get('/', (req, res) => {
  res.send('Backend is running!');
});

// Upload Video Route
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }
  const fileUrl = `/uploads/videos/${req.file.filename}`;
  res.status(200).json({
    success: true,
    filename: req.file.filename,
    url: fileUrl
  });
});

// Parse Prompt Route
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
            { role: "user", content: prompt }
          ]
    });

    const gptResponse = completion.choices[0].message.content;
    console.log("GPT Response:", gptResponse);

    // Clean Markdown code fences if present
    const cleanedResponse = gptResponse.replace(/```json/g, '').replace(/```/g, '').trim();

    // Parse JSON
    const actions = JSON.parse(cleanedResponse);

    // Supported Actions
    const supportedActions = ['cut', 'trim', 'add_subtitles', 'export', 'remove_segment','undo','add_overlay','extract_audio','slow_motion'];
    for (const act of actions.actions) {
      if (!supportedActions.includes(act.action)) {
        return res.status(400).json({
          success: false,
          message: `The requested action '${act.action}' is not currently supported.`
        });
      }
    }

    res.status(200).json({ success: true, actions });
  } catch (error) {
    console.error("Error parsing prompt:", error);
    res.status(500).json({
      success: false,
      message: "Failed to parse prompt",
      error: error.message
    });
  }
});

// Cut Video Route
app.post('/api/cut-video', async (req, res) => {
  const { filename, start, end, user_id} = req.body;

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

  // Get video duration using ffprobe
  exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFilePath}"`, (error, stdout) => {
    if (error) {
      console.error("ffprobe error:", error);
      return res.status(500).json({ success: false, message: 'Failed to analyze video duration.', error: error.message });
    }

    const videoDuration = parseFloat(stdout);

    // ✅ Resolve relative timestamps now that we have duration
    const resolvedStart = resolveRelativeTime(start, videoDuration);
    const resolvedEnd = resolveRelativeTime(end, videoDuration);

    const timeFormatRegex = /^([0-1]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
    if (!timeFormatRegex.test(resolvedStart) || !timeFormatRegex.test(resolvedEnd)) {
      return res.status(400).json({ success: false, message: 'Invalid time format after resolution. Use HH:MM:SS.' });
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

    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(filename);
    const outputFilename = `cut-${uniqueSuffix}${ext}`;
    const outputFilePath = path.join(cutsDir, outputFilename);

    const command = `ffmpeg -i "${inputFilePath}" -ss ${resolvedStart} -to ${adjustedEnd} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k "${outputFilePath}"`;

    exec(command, (error) => {
      if (error) {
        console.error("FFmpeg error:", error);
        return res.status(500).json({ success: false, message: 'Failed to cut video.', error: error.message });
      }

      const fileUrl = `/uploads/cuts/${outputFilename}`;
      res.status(200).json({ success: true, message: 'Video cut successfully.', url: fileUrl });
    });
  });
});
app.get('/force-download/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(__dirname, 'downloads', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  res.download(filePath); // forces download
});

app.post('/api/add-overlay', async (req, res) => {
  const { prompt, filename, user_id } = req.body;

  if (!prompt || !filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid prompt or filename.' });
  }

  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath) {
    return res.status(404).json({ success: false, message: 'Video file not found.' });
  }

  const overlayData = parseOverlayPrompt(prompt);
  console.log("🧠 Parsed Overlay Data:", overlayData);

  // 🕒 Resolve 'END' to actual duration
  let durationSeconds;
  if (overlayData.start_time === 'END') {
    try {
      durationSeconds = await getVideoDuration(inputFilePath);
      overlayData.start_time = Math.floor(durationSeconds - overlayData.duration);
    } catch (err) {
      console.error("Failed to get video duration:", err);
      return res.status(500).json({ success: false, message: 'Failed to get video duration.', error: err.message });
    }
  }

  const drawtextCommand = generateDrawtextCommand(overlayData);
  console.log("🎬 Final drawtext command:", drawtextCommand);

  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
  const ext = path.extname(filename);
  const outputFilename = `overlay-${uniqueSuffix}${ext}`;
  const outputFilePath = path.join(cutsDir, outputFilename);

  const ffmpegArgs = [
    '-y',
    '-i', inputFilePath,
    '-vf', drawtextCommand,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'copy',
    outputFilePath
  ];

  console.log("🚀 Running FFmpeg with args:", ffmpegArgs.join(" "));

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stderr.on('data', data => {
    console.log(`📼 FFmpeg stderr: ${data}`);
  });

  ffmpeg.on('close', code => {
    if (code === 0) {
      console.log("✅ Overlay added successfully.");
      return res.status(200).json({
        success: true,
        message: 'Overlay added.',
        url: `/uploads/cuts/${outputFilename}`
      });
    } else {
      console.error("❌ FFmpeg exited with code:", code);
      return res.status(500).json({ success: false, message: 'Overlay failed.', code });
    }
  });

  ffmpeg.on('error', err => {
    console.error("🚨 FFmpeg error:", err);
    return res.status(500).json({ success: false, message: 'Failed to start FFmpeg.', error: err.message });
  });
});


app.post('/api/slow-motion', async (req, res) => {
  const { filename, start, end, speed } = req.body;
  if (!filename || !start || !end || !speed) {
    return res.status(400).json({ success: false, message: 'Missing filename, start, end or speed.' });
  }

  // 1️⃣ Locate & validate file
  const inputPath = getVideoPath(filename);
  if (!inputPath) {
    return res.status(404).json({ success: false, message: 'Video not found.' });
  }

  // 2️⃣ Get total duration
  let fullDur;
  try {
    fullDur = await getVideoDuration(inputPath);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Could not probe duration.' });
  }

  // 3️⃣ Resolve start/end keywords to HH:MM:SS
  const norm = t => {
    if (t === 'start') return '00:00:00';
    if (t === 'end') return secondsToTime(fullDur);
    if (t.startsWith('end-')) {
      const sub = timeToSeconds(t.replace('end-',''));
      return secondsToTime(Math.max(0, fullDur - sub));
    }
    return t;
  };
  const sHH = norm(start);
  const eHH = norm(end);

  // 4️⃣ Turn into seconds
  const sSec = timeToSeconds(sHH);
  const eSec = timeToSeconds(eHH);
  if (sSec >= eSec || eSec > fullDur) {
    return res.status(400).json({ success: false, message: 'Invalid time range.' });
  }

  // 5️⃣ Validate speed
  const sp = parseFloat(speed);
  if (isNaN(sp) || sp <= 0 || sp > 5) {
    return res.status(400).json({ success: false, message: 'Speed must be between 0.1 and 5.' });
  }
  const origLen = eSec - sSec;
  const slowLen = origLen / sp;

  // 6️⃣ Prepare filenames
  const ext = path.extname(filename);
  const uid = `${Date.now()}-${Math.round(Math.random()*1e6)}`;
  const partA = start === 'start'
    ? null
    : path.join(cutsDir, `pre-${uid}${ext}`);
  const partB = path.join(cutsDir, `slow-${uid}${ext}`);
  const partC = end === 'end'
    ? null
    : path.join(cutsDir, `post-${uid}${ext}`);
  const listTxt = path.join(cutsDir, `list-${uid}.txt`);
  const out    = path.join(cutsDir, `slowmo-${uid}${ext}`);

  // 7️⃣ Build commands
  const cmds = [];

  if (partA) {
    // grab from 0 to sSec
    cmds.push({
      path: partA,
      cmd: `ffmpeg -y -ss 0 -i "${inputPath}" -t ${sSec} -c copy "${partA}"`
    });
  }

  // slow-down segment
  cmds.push({
    path: partB,
    cmd:
      `ffmpeg -y -ss ${sSec} -i "${inputPath}" -t ${origLen} ` +
      `-filter_complex "[0:v]setpts=${1/sp}*PTS[v];[0:a]atempo=${sp}[a]" ` +
      `-map "[v]" -map "[a]" -t ${slowLen} "${partB}"`
  });

  if (partC) {
    // copy from eSec to end
    cmds.push({
      path: partC,
      cmd: `ffmpeg -y -ss ${eSec} -i "${inputPath}" -c copy "${partC}"`
    });
  }

  // 8️⃣ Run them in sequence
  try {
    for (const item of cmds) {
      await new Promise((ok, fail) => {
        exec(item.cmd, err => err ? fail(err) : ok());
      });
    }

    // 9️⃣ Write concat list
    const lines = cmds.map(i => `file '${i.path}'`).join('\n') + '\n';
    fs.writeFileSync(listTxt, lines);

    // 10️⃣ Concat demuxer
    await new Promise((ok, fail) => {
      exec(
        `ffmpeg -y -f concat -safe 0 -i "${listTxt}" -c:v libx264 -preset fast -crf 23 -c:a aac "${out}"`,
        err => err ? fail(err) : ok()
      );
    });

    // 11️⃣ Cleanup intermediates
    cmds.forEach(i => fs.existsSync(i.path) && fs.unlinkSync(i.path));
    fs.unlinkSync(listTxt);

    // 12️⃣ Done
    return res.json({ success: true, url: `/uploads/cuts/slowmo-${uid}${ext}` });

  } catch (err) {
    console.error('💥 Slow-motion failed:', err);
    return res.status(500).json({ success: false, message: 'Processing failed.', error: err.message });
  }

  // ——— helpers ———
  function timeToSeconds(ts) {
    const [H,M,S] = ts.split(':').map(n=>Number(n));
    return H*3600 + M*60 + S;
  }
  function secondsToTime(sec) {
    const H = Math.floor(sec/3600).toString().padStart(2,'0');
    const M = Math.floor((sec%3600)/60).toString().padStart(2,'0');
    const S = Math.floor(sec%60).toString().padStart(2,'0');
    return `${H}:${M}:${S}`;
  }
});

app.post('/api/extract-audio', async (req, res) => {
  const { filename, format, user_id } = req.body;

  if (!filename) {
    return res.status(400).json({ success: false, message: "Missing filename" });
  }
  const downloadDir = path.join(__dirname, "downloads");
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir);
    }

  let outputFormat = "mp3";
  if (format === "wav") {
    outputFormat = "wav";
  }

  const inputPath = path.join(__dirname, "uploads", "videos", filename);
  const baseName = path.parse(filename).name;
  const outputName = "audio-" + Date.now() + "-" + Math.floor(Math.random() * 10000) + "." + outputFormat;
  const outputPath = path.join(__dirname, "downloads", outputName);

  let ffmpegCommand = "";
  if (outputFormat === "mp3") {
    ffmpegCommand = `ffmpeg -i "${inputPath}" -vn -acodec libmp3lame "${outputPath}"`;
  } else if (outputFormat === "wav") {
    ffmpegCommand = `ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le "${outputPath}"`;
  } else {
    return res.status(400).json({ success: false, message: "Unsupported format" });
  }

  console.log("🎧 Extracting audio with command:", ffmpegCommand);

  exec(ffmpegCommand, (error, stdout, stderr) => {
    if (error) {
      console.error("❌ FFmpeg error:", stderr);
      return res.status(500).json({ success: false, message: "Audio extraction failed" });
    }

    return res.status(200).json({
      success: true,
      url: "/downloads/" + outputName,
    });
  });
});




app.post('/api/add-subtitles', async (req, res) => {
  const { filename,user_id } = req.body;
  console.log("📝 Add subtitles requested by user:", user_id);

  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
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

  const outputFilename = `subtitled-${uniqueSuffix}${path.extname(filename)}`;
  const outputFilePath = path.join(cutsDir, outputFilename);

  // Step 1: Extract audio
  const extractCommand = `ffmpeg -i "${inputFilePath}" -vn -acodec libmp3lame -ar 44100 -ac 2 -ab 192k "${audioFilePath}"`;

  exec(extractCommand, async (error) => {
    if (error) {
      console.error("Audio extraction error:", error);
      return res.status(500).json({ success: false, message: 'Failed to extract audio.', error: error.message });
    }

    try {
      // Step 2: Transcribe audio to SRT
      const transcription = await openai.audio.transcriptions.create({
        model: "whisper-1",
        file: fs.createReadStream(audioFilePath),
        response_format: "srt"
      });

      // Save subtitles to file
      fs.writeFileSync(srtFilePath, transcription);

      // Step 3: Burn subtitles into video
      const burnCommand = `ffmpeg -i "${inputFilePath}" -vf subtitles="${srtFilePath}" -c:a copy "${outputFilePath}"`;

      exec(burnCommand, (burnErr) => {
        if (burnErr) {
          console.error("Subtitle burn error:", burnErr);
          return res.status(500).json({ success: false, message: 'Failed to burn subtitles.', error: burnErr.message });
        }

        // Optional cleanup
        fs.unlink(audioFilePath, () => {});
        fs.unlink(srtFilePath, () => {});

        const fileUrl = `/uploads/cuts/${outputFilename}`;
        return res.status(200).json({
          success: true,
          message: 'Subtitles added and burned into video.',
          url: fileUrl
        });
      });

    } catch (err) {
      console.error("Whisper error:", err);
      return res.status(500).json({ success: false, message: 'Failed to generate subtitles.', error: err.message });
    }
  });
});

// app.post('/api/export', async (req, res) => {
//   console.log("📦 Incoming export request:", req.body); // Add this

//   const { filename, targetFormat, newName, parts } = req.body;
//   console.log(parts)
//   // Case 1: Concat export based on `parts`
//   if (Array.isArray(parts) && parts.length > 0) {
//       console.log("📁 Preparing concat for parts:", parts); // Add this

//     let baseName;
//     if (newName) {
//       baseName = newName.replace(/\s+/g, '_');
//     } else {
//       baseName = `exported-${Date.now()}`;
//     }
//     const outputFilename = baseName + '.mp4';
//     const outputFilePath = path.join(cutsDir, outputFilename);

//     const listPath = path.join(cutsDir, `concat-list-${Date.now()}.txt`);
//     const listContent = parts
//       .map(p => `file '${path.join(cutsDir, p)}'`)
//       .join('\n');
//     fs.writeFileSync(listPath, listContent);

//     const cmd = `ffmpeg -f concat -safe 0 -i "${listPath}" -c:v libx264 -preset fast -crf 23 -c:a aac "${outputFilePath}"`;
//     console.log("🧾 Writing concat list:\n" + listContent);

//     console.log("🚀 Running command:", cmd);

//     exec(cmd, (err) => {
//       fs.unlink(listPath, () => {}); // cleanup

//       if (err) {
//         console.error('Concat export error:', err);
//         return res.status(500).json({
//           success: false,
//           message: 'Concat export failed.',
//           error: err.message
//         });
//       }

//       return res.status(200).json({
//         success: true,
//         message: 'Export complete.',
//         url: `/uploads/cuts/${outputFilename}`
//       });
//     });
//     return;
//   }

//   // Case 2: Single file format conversion
//   if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
//     return res.status(400).json({ success: false, message: 'Invalid filename' });
//   }

//   const validFormats = ['mp4', 'mov', 'webm'];
//   let ext;
//   if (targetFormat) {
//     ext = targetFormat.toLowerCase();
//   } else {
//     ext = 'mp4';
//   }

//   if (!validFormats.includes(ext)) {
//     return res.status(400).json({ success: false, message: 'Invalid or unsupported export format.' });
//   }

//   const inputFilePath = getVideoPath(filename);
//   if (!inputFilePath) {
//     return res.status(404).json({ success: false, message: 'Video file not found.' });
//   }

//   let baseName;
//   if (newName) {
//     baseName = newName.replace(/\s+/g, '_');
//   } else {
//     baseName = `exported-${Date.now()}`;
//   }

//   const outputFilename = baseName + '.' + ext;
//   const outputFilePath = path.join(cutsDir, outputFilename);

//   const command = `ffmpeg -i "${inputFilePath}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k "${outputFilePath}"`;
//   console.log("🎯 Resolved input path:", inputFilePath);
//   console.log("📤 Running FFmpeg command:", command);

//   exec(command, (error,stdout,stderr) => {
//     if (error) {
//       console.error("FFmpeg export error:", error);
//       return res.status(500).json({
//         success: false,
//         message: 'Export failed.',
//         error: error.message
//       });
//     }
//     console.log("✅ FFmpeg export success!");
//     console.log("🧾 stdout:", stdout);
//     console.log("⚠️ stderr:", stderr);
//     console.log("📤 Exported file at:", outputFilePath);

//     return res.status(200).json({
//       success: true,
//       message: 'Export complete.',
//       url: `/uploads/cuts/${outputFilename}`
//     });
//   });
// });
app.post('/api/export', (req, res) => {
  const { filename, targetFormat, newName,user_id } = req.body;

  const inputFilePath = getVideoPath(filename);
  if (!inputFilePath) {
    return res.status(404).json({ success: false, message: 'Video file not found.' });
  }

  let baseName = newName ? newName.replace(/\s+/g, '_') : `exported-${Date.now()}`;
  const extension = targetFormat || 'mp4';
  const outputFilename = `${baseName}.${extension}`;
  const outputPath = path.join(cutsDir, outputFilename);

  const ffmpegArgs = [
  '-y', // 👈 this is the critical fix — overwrite existing output without asking
  '-i', inputFilePath,
  '-c:v', 'libx264',
  '-preset', 'fast',
  '-crf', '23',
  '-c:a', 'aac',
  '-b:a', '192k',
  outputPath
];


  console.log("🚀 Spawning FFmpeg with args:", ffmpegArgs.join(' '));

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
    } else {
      console.error('❌ FFmpeg exited with code:', code);
      return res.status(500).json({
        success: false,
        message: 'Export failed.',
        code
      });
    }
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
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
