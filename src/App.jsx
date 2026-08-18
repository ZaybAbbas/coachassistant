import React, { useState, useRef, useEffect } from 'react';
import { 
  Users, MessageSquare, Plus, 
  FileText, Copy, Check, Loader2, AlertCircle, 
  Calendar, Upload, Trash2, Camera, ImagePlus, Download,
  ArrowRight, MousePointer2, PenLine, Circle as CircleIcon, ArrowUpRight, Undo, Eraser,
  Minus, Type, Activity, Mic, FileAudio
} from 'lucide-react';

// Secure API Key connection to Vercel
const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

// Exponential backoff fetch for Gemini API
const fetchWithRetry = async (url, options, retries = 5) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      const delay = Math.pow(2, i) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Helper: Compress File before converting to Base64 (Prevents API Error 13)
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      // Set a max dimension to prevent massive smartphone photos from crashing the AI
      const MAX_DIM = 1200; 
      let { width, height } = img;
      
      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width *= ratio;
        height *= ratio;
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      
      // Compress to JPEG with 75% quality to save payload space
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.75), name: file.name });
    };
    img.onerror = error => reject(error);
    img.src = event.target.result;
  };
  reader.onerror = error => reject(error);
});

// Helper: Read Audio File as Base64 for transcription
const readAudioFileAsBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (event) => {
    const matches = event.target.result.match(/^data:(audio\/[a-zA-Z0-9.-]+);base64,(.+)$/);
    if (matches) {
      resolve({ mimeType: matches[1], data: matches[2], name: file.name });
    } else {
      reject(new Error("Invalid audio format"));
    }
  };
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

// Helper: Load Image for Canvas
const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

// --- CANVAS COMPOSITING LOGIC ---
const generateCompositeImage = async (beforeSrc, afterSrc) => {
  const [imgBefore, imgAfter] = await Promise.all([loadImage(beforeSrc), loadImage(afterSrc)]);
  
  const TARGET_HEIGHT = 800;
  const scaleBefore = TARGET_HEIGHT / imgBefore.height;
  const scaleAfter = TARGET_HEIGHT / imgAfter.height;
  
  const w1 = imgBefore.width * scaleBefore;
  const w2 = imgAfter.width * scaleAfter;
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  canvas.width = w1 + w2;
  canvas.height = TARGET_HEIGHT;
  
  // 1. Fill Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // 2. Draw Images Side by Side
  ctx.drawImage(imgBefore, 0, 0, w1, TARGET_HEIGHT);
  ctx.drawImage(imgAfter, w1, 0, w2, TARGET_HEIGHT);
  
  // 3. Draw Center Divider Line
  ctx.beginPath();
  ctx.moveTo(w1, 0);
  ctx.lineTo(w1, TARGET_HEIGHT);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // 4. Draw Header Badges ("BEFORE" / "AFTER")
  const drawBadge = (text, x) => {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)'; // Slate 900 w/ opacity
    ctx.roundRect(x, 20, 120, 44, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 60, 42);
  };
  
  if (!ctx.roundRect) {
    ctx.roundRect = function(x, y, w, h, r) {
      this.beginPath(); this.moveTo(x+r, y); this.lineTo(x+w-r, y); this.quadraticCurveTo(x+w, y, x+w, y+r);
      this.lineTo(x+w, y+h-r); this.quadraticCurveTo(x+w, y+h, x+w-r, y+h); this.lineTo(x+r, y+h);
      this.quadraticCurveTo(x, y+h, x, y+h-r); this.lineTo(x, y+r); this.quadraticCurveTo(x, y, x+r, y); this.closePath();
    }
  }

  drawBadge('BEFORE', 20);
  drawBadge('AFTER', w1 + 20);

  return canvas.toDataURL('image/jpeg', 0.9);
};

export default function App() {
  // App State - Workbench layout (no clients, just transient arrays)
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' or 'photos' or 'transcription'
  const [analyses, setAnalyses] = useState([]);
  const [photoAnalyses, setPhotoAnalyses] = useState([]);
  const [transcriptions, setTranscriptions] = useState([]);
  
  // Chat Analysis State
  const [chatInput, setChatInput] = useState('');
  const [audioData, setAudioData] = useState(null);
  const [isAnalyzingChat, setIsAnalyzingChat] = useState(false);
  const [chatError, setChatError] = useState('');
  const chatFileInputRef = useRef(null);

  // Transcription State
  const [stagedAudioFiles, setStagedAudioFiles] = useState([]);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState('');
  const transcriptionFileInputRef = useRef(null);

  // Photo Analysis State
  const [uploadMode, setUploadMode] = useState('batch'); // 'batch' or 'manual'
  const [stagedPhotos, setStagedPhotos] = useState([]);
  const [isAnalyzingPhotos, setIsAnalyzingPhotos] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const photoFileInputRef = useRef(null);

  // Manual Photo Mode State
  const [manualPhotos, setManualPhotos] = useState({
    front: { before: null, after: null },
    side: { before: null, after: null },
    back: { before: null, after: null }
  });

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleChatDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;

    if (file.type.startsWith('audio/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const matches = event.target.result.match(/^data:(audio\/[a-zA-Z0-9.-]+);base64,(.+)$/);
        if (matches) {
          setAudioData({ mimeType: matches[1], data: matches[2], name: file.name });
          setChatInput('');
          setChatError('');
        } else {
          setChatError("Failed to process audio file.");
        }
      };
      reader.onerror = () => setChatError("Failed to read the audio file.");
      reader.readAsDataURL(file);
      return;
    }

    if (!file.name.endsWith('.txt')) {
      setChatError("Please drop a valid .txt or audio file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      setChatInput(event.target.result);
      setAudioData(null);
    };
    reader.onerror = () => setChatError("Failed to read the file.");
    reader.readAsText(file);
  };

  const handlePhotoDrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    try {
      const base64Promises = files.map(file => fileToBase64(file));
      const base64Results = await Promise.all(base64Promises);
      setStagedPhotos(prev => [...prev, ...base64Results]);
    } catch (err) {
      setPhotoError("Failed to load dropped images.");
    }
  };

  const handleTranscriptionDrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/'));
    if (!files.length) return;
    try {
      const base64Promises = files.map(file => readAudioFileAsBase64(file));
      const base64Results = await Promise.all(base64Promises);
      setStagedAudioFiles(prev => [...prev, ...base64Results]);
    } catch (err) {
      setTranscriptionError("Failed to load dropped audio files.");
    }
  };

  const handleManualFile = async (file, viewType, timing) => {
    if (!file) return;
    try {
      const { dataUrl } = await fileToBase64(file);
      setManualPhotos(prev => ({
        ...prev,
        [viewType]: {
          ...prev[viewType],
          [timing]: dataUrl
        }
      }));
    } catch (err) {
      setPhotoError("Failed to load image.");
    }
  };

  const handleManualDrop = (e, viewType, timing) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleManualFile(file, viewType, timing);
    }
  };

  const handleChatUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.type.startsWith('audio/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const matches = event.target.result.match(/^data:(audio\/[a-zA-Z0-9.-]+);base64,(.+)$/);
        if (matches) {
          setAudioData({ mimeType: matches[1], data: matches[2], name: file.name });
          setChatInput('');
          setChatError('');
        } else {
          setChatError("Failed to process audio file.");
        }
      };
      reader.onerror = () => setChatError("Failed to read the audio file.");
      reader.readAsDataURL(file);
      e.target.value = null;
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      setChatInput(event.target.result);
      setAudioData(null);
    };
    reader.onerror = () => setChatError("Failed to read the file.");
    reader.readAsText(file);
    e.target.value = null;
  };

  const analyzeChat = async () => {
    if (!chatInput.trim() && !audioData) {
      setChatError("Please paste text, upload a .txt file, or attach an audio file.");
      return;
    }
    setIsAnalyzingChat(true);
    setChatError('');

    const systemPrompt = `You are an expert fitness coaching diagnostic assistant. Your sole purpose is to deeply analyze massive WhatsApp conversations between a fitness coach and their client, and prepare a highly detailed diagnostic context report. The coach will feed your report into another AI (like Claude) to draft their actual responses, so your job is purely analytical and observational.
    
    Read between the lines, pick up on tone, sentiment, excuses, and recurring themes. 
    Provide a highly structured, professional, and exhaustive report using Markdown with the following exact headers:
    
    ## 🏆 Key Wins
    (List detailed bullet points of what the client did well, achievements, positive habit formations, and consistency over this period. What should the coach praise?)
    
    ## 🔍 Observations
    (Analyze their behaviors, adherence, friction points, complaints, or patterns in their lifestyle/diet/training. Look at *how* they are approaching their journey. Are they making excuses or taking ownership?)
    
    ## 📌 Things Worth Noting
    (Highlight specific life events, minor details, injuries, upcoming vacations, specific food cravings, work stress, or subtle mentions from the chat. These are crucial rapport-building details the coach needs to remember.)
    
    ## 📝 Overall Summary & Tone Analysis
    (Provide a highly dense, concise, and token-efficient summary of the entire provided conversation period. Extract the core themes, behavioral shifts, and overall progress. Analyze their tone—e.g., overwhelmed, motivated, defensive, stressed—without fluff. Deliver a comprehensive psychological and practical read of the client's state of mind in a tight, concentrated format that maximizes detail while minimizing word count for Claude.)`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      
      const parts = [];
      if (audioData) {
        parts.push({ text: "Analyze the following audio voice note/conversation and provide the diagnostic report:" });
        parts.push({ inlineData: { mimeType: audioData.mimeType, data: audioData.data } });
      } else {
        parts.push({ text: `Analyze the following chat log and provide the diagnostic report:\n\n${chatInput}` });
      }

      const payload = {
        contents: [{ parts: parts }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      };

      const data = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const reportText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!reportText) throw new Error("Failed to generate report text.");

      const newAnalysis = {
        id: Date.now().toString(),
        type: 'chat',
        date: new Date().toISOString(),
        chatExcerpt: audioData ? `Audio Analysis: ${audioData.name}` : chatInput.substring(0, 150) + '...',
        report: reportText
      };

      setAnalyses(prev => [newAnalysis, ...prev]);
      setChatInput(''); 
      setAudioData(null);
    } catch (err) {
      setChatError("Analysis failed: " + (err.message || ''));
    } finally {
      setIsAnalyzingChat(false);
    }
  };

  const handleMultiImageSelect = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    try {
      const base64Promises = files.map(file => fileToBase64(file));
      const base64Results = await Promise.all(base64Promises);
      setStagedPhotos(prev => [...prev, ...base64Results]);
    } catch (err) {
      setPhotoError("Failed to load some images.");
    }
    e.target.value = null; // reset input
  };

  const handleMultiAudioSelect = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    try {
      const base64Promises = files.map(file => readAudioFileAsBase64(file));
      const base64Results = await Promise.all(base64Promises);
      setStagedAudioFiles(prev => [...prev, ...base64Results]);
    } catch (err) {
      setTranscriptionError("Failed to load audio files.");
    }
    e.target.value = null;
  };

  const transcribeAudio = async () => {
    if (stagedAudioFiles.length === 0) {
      setTranscriptionError("Please upload at least one audio file.");
      return;
    }
    setIsTranscribing(true);
    setTranscriptionError('');

    const systemPrompt = `You are a professional, highly accurate transcriptionist. Your ONLY job is to transcribe the provided audio verbatim. 
    - DO NOT summarize.
    - DO NOT add commentary or conversational responses.
    - Transcribe every word exactly as spoken, aiming for 95-100% accuracy.
    - Use proper punctuation and paragraph breaks to make it readable.
    - If multiple audio files are provided, separate them clearly with headers like "### Audio File 1", "### Audio File 2", etc.`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      
      const parts = [{ text: "Please transcribe the following audio files verbatim:" }];
      stagedAudioFiles.forEach((audio, index) => {
        parts.push({ text: `Audio File ${index + 1} (${audio.name}):` });
        parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.data } });
      });

      const payload = {
        contents: [{ parts: parts }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      };

      const data = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const transcriptText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!transcriptText) throw new Error("Failed to generate transcription.");

      // Run TL;DR summary and coaching insights in parallel
      const summaryPayload = {
        contents: [{ parts: [{ text: `Here is a voice note transcript:\n\n${transcriptText}\n\nWrite a TL;DR summary. Cover every main point the person raised — don't skip anything important, even if there are many points. Format as a concise bullet list. No waffle, no filler.` }] }]
      };
      const insightsPayload = {
        contents: [{ parts: [{ text: `You are an expert fitness and nutrition coach reading a transcript of a client's voice note.\n\nTranscript:\n${transcriptText}\n\nAnalyse this from a coaching perspective and return two sections:\n\n**What's going well:**\n- List every positive sign — good habits, compliance, wins, mindset shifts, anything the client is doing right. Be specific to what they actually said.\n\n**Needs your attention:**\n- List every area of struggle, concern, inconsistency, or where they need coaching support. Be specific and practical — what does the coach need to follow up on?\n\nOnly include points that are clearly supported by what the client actually said. No waffle.` }] }]
      };

      const [summaryData, insightsData] = await Promise.all([
        fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summaryPayload) }),
        fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(insightsPayload) })
      ]);

      const summaryText = summaryData.candidates?.[0]?.content?.parts?.[0]?.text || null;
      const insightsText = insightsData.candidates?.[0]?.content?.parts?.[0]?.text || null;

      const newTranscription = {
        id: Date.now().toString(),
        type: 'transcription',
        date: new Date().toISOString(),
        fileNames: stagedAudioFiles.map(f => f.name).join(', '),
        text: transcriptText,
        summary: summaryText,
        insights: insightsText
      };

      setTranscriptions(prev => [newTranscription, ...prev]);
      setStagedAudioFiles([]); 
    } catch (err) {
      setTranscriptionError("Transcription failed: " + (err.message || ''));
    } finally {
      setIsTranscribing(false);
    }
  };

  const analyzePhotos = async () => {
    if (stagedPhotos.length < 2) {
      setPhotoError("Please upload at least 2 photos (e.g., a before and after).");
      return;
    }
    setIsAnalyzingPhotos(true);
    setPhotoError('');

    try {
      const extractBase64Data = (dataUrl) => {
        const matches = dataUrl.match(/^data:(image\/[a-zA-Z0-9]+);base64,(.+)$/);
        return { mimeType: matches[1], data: matches[2] };
      };

      const imageParts = stagedPhotos.map(photo => {
        const { mimeType, data } = extractBase64Data(photo.dataUrl);
        return { inlineData: { mimeType, data } };
      });

      const fileMappingText = stagedPhotos.map((photo, index) => `Index ${index}: "${photo.name}"`).join('\n');

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const payload = {
        contents: [{
          parts: [
            { text: `Analyze these ${stagedPhotos.length} fitness progress photos. 
            1. Group them chronologically into Before and After pairs. 
            CRITICAL: You MUST use the dates/text in the filenames provided below to definitively determine which image is older (Before) and newer (After). Do not guess purely on visuals if the dates are clear.
            
            Filenames Mapping:
            ${fileMappingText}
            
            2. Identify the view type for each pair (e.g., 'front', 'side', 'back').
            You MUST return ONLY a valid JSON object with this exact structure:
            {
              "pairs": [
                {
                  "viewType": "front",
                  "beforeImageIndex": 0, 
                  "afterImageIndex": 1
                }
              ]
            }
            'beforeImageIndex' and 'afterImageIndex' are integers matching the order images were provided (0 to ${stagedPhotos.length - 1}).` },
            ...imageParts
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      };

      const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const responseText = response.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!responseText) throw new Error("No response from AI.");
      
      const data = JSON.parse(responseText);

      if (!data.pairs || data.pairs.length === 0) {
        throw new Error("Could not detect matching before/after pairs.");
      }

      const newPhotoAnalyses = [];
      for (const pair of data.pairs) {
        const beforeObj = stagedPhotos[pair.beforeImageIndex];
        const afterObj = stagedPhotos[pair.afterImageIndex];
        
        if (!beforeObj || !afterObj) continue;

        // Generate Composite Canvas Image for this pair (just side-by-side, no AI markup)
        const compositeDataUrl = await generateCompositeImage(beforeObj.dataUrl, afterObj.dataUrl);

        newPhotoAnalyses.push({
          id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
          type: 'photo',
          viewType: pair.viewType,
          date: new Date().toISOString(),
          compositeImage: compositeDataUrl
        });
      }

      setPhotoAnalyses(prev => [...newPhotoAnalyses, ...prev]);
      setStagedPhotos([]); // Reset form

    } catch (err) {
      console.error(err);
      setPhotoError("Image analysis failed. Ensure images are clear. " + (err.message || ''));
    } finally {
      setIsAnalyzingPhotos(false);
    }
  };

  const processManualPhotos = async () => {
    setIsAnalyzingPhotos(true);
    setPhotoError('');
    let processedAny = false;
    const newPhotoAnalyses = [];

    try {
      for (const viewType of ['front', 'side', 'back']) {
        const { before, after } = manualPhotos[viewType];
        if (before && after) {
          processedAny = true;
          const compositeDataUrl = await generateCompositeImage(before, after);
          newPhotoAnalyses.push({
            id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
            type: 'photo',
            viewType: viewType,
            date: new Date().toISOString(),
            compositeImage: compositeDataUrl
          });
        }
      }

      if (!processedAny) {
        setPhotoError("Please provide both before and after photos for at least one view.");
        setIsAnalyzingPhotos(false);
        return;
      }

      setPhotoAnalyses(prev => [...newPhotoAnalyses, ...prev]);
      
      // Reset state
      setManualPhotos({
        front: { before: null, after: null },
        side: { before: null, after: null },
        back: { before: null, after: null }
      });
    } catch (err) {
      console.error(err);
      setPhotoError("Failed to generate composite image.");
    } finally {
      setIsAnalyzingPhotos(false);
    }
  };

  const deleteItem = (type, itemId) => {
    if (type === 'chat') setAnalyses(prev => prev.filter(item => item.id !== itemId));
    if (type === 'photo') setPhotoAnalyses(prev => prev.filter(item => item.id !== itemId));
    if (type === 'transcription') setTranscriptions(prev => prev.filter(item => item.id !== itemId));
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans">
      
      {/* Top Navigation Workspace Header */}
      <header className="bg-white border-b border-slate-200 px-8 py-4 shadow-sm z-10 flex-shrink-0">
        <div className="flex flex-col md:flex-row justify-between items-center max-w-6xl mx-auto w-full gap-4">
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg shadow-sm">
              <Users size={20} className="text-white" />
            </div>
            CoachSync Workspace
          </h1>
          
          <div className="flex bg-slate-100 p-1 rounded-xl shadow-inner">
            <button 
              onClick={() => setActiveTab('chat')}
              className={`flex items-center gap-2 px-5 py-2 rounded-lg font-medium text-sm transition-all duration-200 ${
                activeTab === 'chat' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <MessageSquare size={18} /> Chat Analysis
            </button>
            <button 
              onClick={() => setActiveTab('photos')}
              className={`flex items-center gap-2 px-5 py-2 rounded-lg font-medium text-sm transition-all duration-200 ${
                activeTab === 'photos' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Camera size={18} /> Progress Photos
            </button>
            <button 
              onClick={() => setActiveTab('transcription')}
              className={`flex items-center gap-2 px-5 py-2 rounded-lg font-medium text-sm transition-all duration-200 ${
                activeTab === 'transcription' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Mic size={18} /> Voice Transcription
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto p-8 bg-slate-50">
        <div className="max-w-6xl mx-auto">
          {/* --- CHAT TAB --- */}
          {activeTab === 'chat' && (
            <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <section 
                className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 transition-colors hover:border-indigo-300"
                onDragOver={handleDragOver}
                onDrop={handleChatDrop}
              >
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                    <MessageSquare size={20} className="text-indigo-500" /> New Chat Analysis
                  </h3>
                  <div className="relative">
                    <input type="file" accept=".txt,audio/*" ref={chatFileInputRef} onChange={handleChatUpload} className="hidden" />
                    <button onClick={() => chatFileInputRef.current?.click()} className="text-sm flex items-center gap-2 text-slate-600 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors font-medium">
                      <Upload size={16} /> Upload .txt or Audio
                    </button>
                  </div>
                </div>
                
                {audioData ? (
                  <div className="w-full h-32 p-4 border-2 border-dashed border-indigo-300 bg-indigo-50 rounded-xl flex flex-col items-center justify-center relative shadow-inner">
                    <div className="absolute top-3 right-3">
                      <button onClick={() => setAudioData(null)} className="text-indigo-400 hover:text-indigo-600 bg-white p-1.5 rounded-md shadow-sm transition-colors" title="Remove Audio">
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <Activity size={32} className="text-indigo-500 mb-2" />
                    <p className="font-semibold text-indigo-900 text-sm">Audio File Attached</p>
                    <p className="text-xs text-indigo-600 max-w-[80%] truncate mt-1">{audioData.name}</p>
                  </div>
                ) : (
                  <textarea
                    className="w-full h-32 p-4 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 text-sm shadow-inner resize-none transition-shadow"
                    placeholder="Paste WhatsApp chat history here, or drag and drop a .txt or audio file..."
                    value={chatInput} onChange={(e) => setChatInput(e.target.value)} disabled={isAnalyzingChat}
                  />
                )}

                {chatError && <div className="mt-3 text-red-600 text-sm flex items-center gap-2 bg-red-50 p-2 rounded-lg"><AlertCircle size={16}/>{chatError}</div>}
                <div className="mt-4 flex justify-end">
                  <button onClick={analyzeChat} disabled={isAnalyzingChat || (!chatInput.trim() && !audioData)} className="bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-medium hover:bg-indigo-700 transition-colors disabled:bg-slate-400 flex items-center gap-2 shadow-sm">
                    {isAnalyzingChat ? <><Loader2 size={18} className="animate-spin" /> Analyzing...</> : <><FileText size={18} /> Generate AI Report</>}
                  </button>
                </div>
              </section>

              <section className="space-y-6">
                <h3 className="text-lg font-semibold text-slate-800 border-b border-slate-200 pb-2">Analysis History</h3>
                {analyses.map(analysis => (
                  <ChatReportCard key={analysis.id} analysis={analysis} onDelete={() => deleteItem('chat', analysis.id)} />
                ))}
                {analyses.length === 0 && (
                  <div className="text-center py-16 bg-slate-100/50 rounded-2xl border border-slate-200 border-dashed">
                    <FileText size={48} className="text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-500 font-medium">Your workspace is clean.</p>
                    <p className="text-slate-400 text-sm mt-1">Paste a chat above to generate a new report.</p>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* --- TRANSCRIPTION TAB --- */}
          {activeTab === 'transcription' && (
            <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                    <Mic size={20} className="text-indigo-500" /> Verbatim Voice Transcription
                  </h3>
                </div>

                <div 
                  className="border-2 border-dashed border-slate-300 rounded-xl p-6 flex flex-col items-center justify-center min-h-[200px] bg-slate-50 relative group mb-6 transition-colors hover:bg-slate-100 hover:border-indigo-400"
                  onDragOver={handleDragOver}
                  onDrop={handleTranscriptionDrop}
                >
                  {stagedAudioFiles.length > 0 ? (
                    <div className="w-full">
                      <div className="flex justify-between items-center mb-4">
                        <span className="font-semibold text-slate-700">{stagedAudioFiles.length} voice notes staged for transcription</span>
                        <button onClick={() => setStagedAudioFiles([])} className="text-sm font-medium text-red-500 hover:text-red-700 transition-colors">Clear All</button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {stagedAudioFiles.map((audioObj, i) => (
                          <div key={i} className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
                            <div className="flex items-center gap-3 overflow-hidden">
                              <div className="bg-indigo-50 p-2 rounded-lg"><FileAudio size={20} className="text-indigo-500" /></div>
                              <span className="text-sm font-medium text-slate-700 truncate">{audioObj.name}</span>
                            </div>
                            <button onClick={() => setStagedAudioFiles(prev => prev.filter((_, idx) => idx !== i))} className="text-slate-400 hover:text-red-500 transition-colors">
                              <Trash2 size={16} />
                            </button>
                          </div>
                        ))}
                        <button 
                          onClick={() => transcriptionFileInputRef.current?.click()} 
                          className="bg-white border-2 border-dashed border-slate-300 rounded-xl p-4 flex items-center justify-center gap-2 text-slate-500 hover:bg-slate-50 hover:border-slate-400 transition-colors"
                        >
                          <Plus size={18} /> <span className="text-sm font-medium">Add More</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center text-center">
                      <div className="bg-indigo-50 p-4 rounded-full mb-4">
                        <Mic size={32} className="text-indigo-500" />
                      </div>
                      <h4 className="text-lg font-medium text-slate-700 mb-1">Upload Voice Notes</h4>
                      <p className="text-sm text-slate-500 mb-6 max-w-md">
                        Drag & drop multiple WhatsApp voice notes (.m4a, .mp3, .wav) here. We will transcribe them verbatim with 95%+ accuracy—no summarizing.
                      </p>
                      <button 
                        onClick={() => transcriptionFileInputRef.current?.click()} 
                        className="bg-indigo-50 text-indigo-700 border border-indigo-200 px-6 py-2.5 rounded-xl font-semibold hover:bg-indigo-100 transition-colors flex items-center gap-2 shadow-sm"
                      >
                        <Upload size={18} /> Browse Audio
                      </button>
                    </div>
                  )}
                  <input 
                    type="file" 
                    accept="audio/*" 
                    multiple 
                    ref={transcriptionFileInputRef} 
                    onChange={handleMultiAudioSelect} 
                    className="hidden" 
                  />
                </div>

                {transcriptionError && <div className="mb-4 text-red-600 text-sm flex items-center gap-2 bg-red-50 p-3 rounded-lg"><AlertCircle size={16}/>{transcriptionError}</div>}
                
                <div className="flex justify-end border-t border-slate-100 pt-4">
                  <button 
                    onClick={transcribeAudio} 
                    disabled={isTranscribing || stagedAudioFiles.length === 0} 
                    className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-medium hover:bg-indigo-700 transition-all disabled:bg-slate-400 disabled:cursor-not-allowed flex items-center gap-2 shadow-md hover:shadow-lg"
                  >
                    {isTranscribing ? <><Loader2 size={18} className="animate-spin" /> Transcribing & Summarising...</> : <><Mic size={18} /> Transcribe All Notes</>}
                  </button>
                </div>
              </section>

              <section className="space-y-6">
                <h3 className="text-lg font-semibold text-slate-800 border-b border-slate-200 pb-2">Transcription History</h3>
                {transcriptions.map(transcription => (
                  <TranscriptionReportCard key={transcription.id} transcription={transcription} onDelete={() => deleteItem('transcription', transcription.id)} />
                ))}
                {transcriptions.length === 0 && (
                  <div className="text-center py-16 bg-slate-100/50 rounded-2xl border border-slate-200 border-dashed">
                    <FileAudio size={48} className="text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-500 font-medium">Your workspace is clean.</p>
                    <p className="text-slate-400 text-sm mt-1">Upload voice notes to generate transcripts.</p>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* --- PHOTOS TAB --- */}
          {activeTab === 'photos' && (
            <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mb-6">
                  <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                    <Camera size={20} className="text-indigo-500" /> Visual Progress
                  </h3>
                  <div className="flex bg-slate-100 p-1 rounded-lg w-full sm:w-auto">
                    <button 
                      onClick={() => setUploadMode('batch')} 
                      className={`flex-1 sm:flex-none px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${uploadMode === 'batch' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Batch AI Upload
                    </button>
                    <button 
                      onClick={() => setUploadMode('manual')} 
                      className={`flex-1 sm:flex-none px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${uploadMode === 'manual' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Manual Pair
                    </button>
                  </div>
                </div>

                {uploadMode === 'batch' ? (
                  <>
                    <div 
                      className="border-2 border-dashed border-slate-300 rounded-xl p-6 flex flex-col items-center justify-center min-h-[250px] bg-slate-50 relative group mb-6 transition-colors hover:bg-slate-100 hover:border-indigo-400"
                      onDragOver={handleDragOver}
                      onDrop={handlePhotoDrop}
                    >
                      {stagedPhotos.length > 0 ? (
                        <div className="w-full">
                          <div className="flex justify-between items-center mb-4">
                            <span className="font-semibold text-slate-700">{stagedPhotos.length} photos staged for analysis</span>
                            <button onClick={() => setStagedPhotos([])} className="text-sm font-medium text-red-500 hover:text-red-700 transition-colors">Clear All</button>
                          </div>
                          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-4">
                            {stagedPhotos.map((photoObj, i) => (
                              <div key={i} className="aspect-square rounded-lg overflow-hidden border border-slate-200 relative shadow-sm group/item">
                                <div className="absolute top-1.5 left-1.5 bg-slate-900/70 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow-sm backdrop-blur-sm z-10">{i}</div>
                                <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white text-[9px] truncate px-1.5 py-1 z-10 opacity-0 group-hover/item:opacity-100 transition-opacity" title={photoObj.name}>
                                  {photoObj.name}
                                </div>
                                <img src={photoObj.dataUrl} alt={`Upload ${i}`} className="w-full h-full object-cover relative z-0" />
                              </div>
                            ))}
                            <button 
                              onClick={() => photoFileInputRef.current?.click()} 
                              className="aspect-square rounded-lg border-2 border-dashed border-slate-300 flex flex-col items-center justify-center hover:bg-slate-200 hover:border-slate-400 transition-colors text-slate-500 bg-white"
                            >
                              <Plus size={24} className="mb-1" />
                              <span className="text-[10px] font-medium uppercase tracking-wider">Add More</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center text-center">
                          <div className="bg-indigo-50 p-4 rounded-full mb-4">
                            <ImagePlus size={32} className="text-indigo-500" />
                          </div>
                          <h4 className="text-lg font-medium text-slate-700 mb-1">Upload Progress Photos</h4>
                          <p className="text-sm text-slate-500 mb-6 max-w-md">
                            Select multiple photos at once (e.g. 6 photos). The AI will automatically pair them up chronologically and organize them by front, side, and back views.
                          </p>
                          <button 
                            onClick={() => photoFileInputRef.current?.click()} 
                            className="bg-indigo-50 text-indigo-700 border border-indigo-200 px-6 py-2.5 rounded-xl font-semibold hover:bg-indigo-100 transition-colors flex items-center gap-2 shadow-sm"
                          >
                            <Upload size={18} /> Browse Images
                          </button>
                        </div>
                      )}
                      <input 
                        type="file" 
                        accept="image/*" 
                        multiple 
                        ref={photoFileInputRef} 
                        onChange={handleMultiImageSelect} 
                        className="hidden" 
                      />
                    </div>

                    {photoError && <div className="mb-4 text-red-600 text-sm flex items-center gap-2 bg-red-50 p-3 rounded-lg"><AlertCircle size={16}/>{photoError}</div>}
                    
                    <div className="flex justify-end border-t border-slate-100 pt-4">
                      <button 
                        onClick={analyzePhotos} 
                        disabled={isAnalyzingPhotos || stagedPhotos.length < 2} 
                        className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-medium hover:bg-indigo-700 transition-all disabled:bg-slate-400 disabled:cursor-not-allowed flex items-center gap-2 shadow-md hover:shadow-lg"
                      >
                        {isAnalyzingPhotos ? <><Loader2 size={18} className="animate-spin" /> Analyzing Bulk Photos...</> : <><Camera size={18} /> Process & Pair All Photos</>}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-4">
                      <p className="text-sm text-slate-500">Drag & drop individual photos to pair them manually. Fill out any or all views.</p>
                    </div>

                    <div className="space-y-6 mb-6">
                      {['front', 'side', 'back'].map(viewType => (
                        <div key={viewType} className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                          <h4 className="text-md font-semibold text-slate-800 capitalize mb-3 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                            {viewType} View
                          </h4>
                          <div className="grid grid-cols-2 gap-4">
                            {/* Manual Before Dropzone */}
                            <div 
                              className="border-2 border-dashed border-slate-300 rounded-xl p-4 flex flex-col items-center justify-center min-h-[200px] bg-white relative overflow-hidden group hover:border-indigo-400 transition-colors"
                              onDragOver={handleDragOver}
                              onDrop={(e) => handleManualDrop(e, viewType, 'before')}
                            >
                              {manualPhotos[viewType].before ? (
                                <>
                                  <img src={manualPhotos[viewType].before} alt={`${viewType} Before`} className="absolute inset-0 w-full h-full object-contain opacity-50 group-hover:opacity-30 transition-opacity" />
                                  <button onClick={() => setManualPhotos(prev => ({...prev, [viewType]: {...prev[viewType], before: null}}))} className="z-10 bg-white text-slate-700 px-3 py-1.5 rounded-lg font-medium shadow border border-slate-200 hover:bg-slate-50 text-xs">Remove Before</button>
                                </>
                              ) : (
                                <>
                                  <ImagePlus size={24} className="text-slate-400 mb-2" />
                                  <p className="text-xs font-medium text-slate-700 mb-1">Old Photo (Before)</p>
                                  <input id={`upload-${viewType}-before`} type="file" accept="image/*" onChange={(e) => { handleManualFile(e.target.files[0], viewType, 'before'); e.target.value = null; }} className="hidden" />
                                  <button onClick={() => document.getElementById(`upload-${viewType}-before`).click()} className="text-[10px] text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-md font-semibold hover:bg-indigo-100 mt-2">Browse or Drop</button>
                                </>
                              )}
                            </div>

                            {/* Manual After Dropzone */}
                            <div 
                              className="border-2 border-dashed border-slate-300 rounded-xl p-4 flex flex-col items-center justify-center min-h-[200px] bg-white relative overflow-hidden group hover:border-indigo-400 transition-colors"
                              onDragOver={handleDragOver}
                              onDrop={(e) => handleManualDrop(e, viewType, 'after')}
                            >
                              {manualPhotos[viewType].after ? (
                                <>
                                  <img src={manualPhotos[viewType].after} alt={`${viewType} After`} className="absolute inset-0 w-full h-full object-contain opacity-50 group-hover:opacity-30 transition-opacity" />
                                  <button onClick={() => setManualPhotos(prev => ({...prev, [viewType]: {...prev[viewType], after: null}}))} className="z-10 bg-white text-slate-700 px-3 py-1.5 rounded-lg font-medium shadow border border-slate-200 hover:bg-slate-50 text-xs">Remove After</button>
                                </>
                              ) : (
                                <>
                                  <ImagePlus size={24} className="text-slate-400 mb-2" />
                                  <p className="text-xs font-medium text-slate-700 mb-1">New Photo (After)</p>
                                  <input id={`upload-${viewType}-after`} type="file" accept="image/*" onChange={(e) => { handleManualFile(e.target.files[0], viewType, 'after'); e.target.value = null; }} className="hidden" />
                                  <button onClick={() => document.getElementById(`upload-${viewType}-after`).click()} className="text-[10px] text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-md font-semibold hover:bg-indigo-100 mt-2">Browse or Drop</button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {photoError && <div className="mb-4 text-red-600 text-sm flex items-center gap-2 bg-red-50 p-3 rounded-lg"><AlertCircle size={16}/>{photoError}</div>}
                    
                    <div className="flex justify-end border-t border-slate-100 pt-4">
                      <button 
                        onClick={processManualPhotos} 
                        disabled={isAnalyzingPhotos || !Object.values(manualPhotos).some(v => v.before && v.after)} 
                        className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-medium hover:bg-indigo-700 transition-all disabled:bg-slate-400 disabled:cursor-not-allowed flex items-center gap-2 shadow-md hover:shadow-lg"
                      >
                        {isAnalyzingPhotos ? <><Loader2 size={18} className="animate-spin" /> Generating...</> : <><Camera size={18} /> Generate Side-by-Sides</>}
                      </button>
                    </div>
                  </>
                )}
              </section>

              <section className="space-y-8">
                <h3 className="text-lg font-semibold text-slate-800 border-b border-slate-200 pb-2">Generated Composites</h3>
                {photoAnalyses.map(analysis => (
                  <PhotoReportCard key={analysis.id} analysis={analysis} onDelete={() => deleteItem('photo', analysis.id)} clientName="Client" />
                ))}
                {photoAnalyses.length === 0 && (
                  <div className="text-center py-16 bg-slate-100/50 rounded-2xl border border-slate-200 border-dashed">
                    <ImagePlus size={48} className="text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-500 font-medium">Your workspace is clean.</p>
                    <p className="text-slate-400 text-sm mt-1">Upload images above to generate side-by-sides.</p>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// Subcomponent: Chat Report Card
function ChatReportCard({ analysis, onDelete }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(analysis.report).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      const ta = document.createElement("textarea"); ta.value = analysis.report; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch(e){} document.body.removeChild(ta);
    });
  };

  const formatReport = (text) => {
    const sections = text.split('##').filter(s => s.trim());
    return sections.map((section, idx) => {
      const lines = section.split('\n');
      const title = lines[0].trim();
      const content = lines.slice(1).join('\n').trim();
      const formattedContent = content.split('\n').map((line, i) => {
        let l = line.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-800">$1</strong>');
        if (l.trim().startsWith('*') || l.trim().startsWith('-')) return `<li class="mb-2 ml-4 list-disc marker:text-indigo-400">${l.replace(/^[\*\-]\s*/, '')}</li>`;
        return l ? `<p class="mb-2">${l}</p>` : '';
      }).join('');
      return (
        <div key={idx} className="mb-6 last:mb-0">
          <h4 className="text-lg font-bold text-slate-800 mb-3 pb-2 border-b border-slate-100">{title}</h4>
          <div className="text-slate-600 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: formattedContent }} />
        </div>
      );
    });
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden group">
      <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex justify-between items-center">
        <div className="flex items-center gap-2 text-slate-600"><Calendar size={16} /><span className="font-medium text-sm">{new Date(analysis.date).toLocaleDateString()}</span></div>
        <div className="flex items-center gap-2">
          <button onClick={handleCopy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors shadow-sm">
            {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />} {copied ? 'Copied!' : 'Copy'}
          </button>
          <button onClick={onDelete} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button>
        </div>
      </div>
      <div className="p-6">{formatReport(analysis.report)}</div>
    </div>
  );
}

// Subcomponent: Transcription Report Card
function TranscriptionReportCard({ transcription, onDelete }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(transcription.text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      const ta = document.createElement("textarea"); ta.value = transcription.text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch(e){} document.body.removeChild(ta);
    });
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden group">
      <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex justify-between items-center">
        <div className="flex items-center gap-4 text-slate-600">
          <div className="flex items-center gap-2"><Calendar size={16} /><span className="font-medium text-sm">{new Date(transcription.date).toLocaleDateString()}</span></div>
          <div className="flex items-center gap-2 text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded-md max-w-[200px] truncate" title={transcription.fileNames}>
            <FileAudio size={14} /> {transcription.fileNames}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleCopy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors shadow-sm">
            {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />} {copied ? 'Copied!' : 'Copy'}
          </button>
          <button onClick={onDelete} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button>
        </div>
      </div>
      {transcription.summary && (
        <div className="px-6 pt-5 pb-4 bg-indigo-50 border-b border-indigo-100">
          <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-2">TL;DR — Key Points</p>
          <div className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap font-sans">
            {transcription.summary}
          </div>
        </div>
      )}
      {transcription.insights && (
        <div className="grid grid-cols-2 border-b border-slate-200">
          {(() => {
            const wellMatch = transcription.insights.match(/\*\*What's going well[:\*]*\*\*([\s\S]*?)(?=\*\*Needs your attention|$)/i);
            const focusMatch = transcription.insights.match(/\*\*Needs your attention[:\*]*\*\*([\s\S]*?)$/i);
            const wellText = wellMatch?.[1]?.trim() || null;
            const focusText = focusMatch?.[1]?.trim() || null;
            return (
              <>
                {wellText && (
                  <div className="px-5 py-4 bg-emerald-50 border-r border-slate-200">
                    <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wide mb-2">✅ What's going well</p>
                    <div className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap font-sans">{wellText}</div>
                  </div>
                )}
                {focusText && (
                  <div className="px-5 py-4 bg-amber-50">
                    <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-2">⚠️ Needs your attention</p>
                    <div className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap font-sans">{focusText}</div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
      <div className="p-6">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Full Transcript</p>
        <div className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap font-sans">
          {transcription.text}
        </div>
      </div>
    </div>
  );
}

// Subcomponent: Photo Report Card with Drawing Tools
function PhotoReportCard({ analysis, onDelete, clientName }) {
  const canvasRef = useRef(null);
  const [tool, setTool] = useState('arrow'); 
  const [color, setColor] = useState('#ef4444'); 
  const [drawings, setDrawings] = useState([]);
  const [currentDrawing, setCurrentDrawing] = useState(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [textInput, setTextInput] = useState({ active: false, coords: null, text: '', editingId: null });
  
  // States to manage moving/resizing selected text items
  const [selectedId, setSelectedId] = useState(null);
  const [interaction, setInteraction] = useState(null);
  const lastClickRef = useRef({ time: 0, id: null });

  const colors = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#ffffff', '#000000'];

  // Initialize and redraw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const img = new Image();
    img.onload = () => {
      if (imageSize.width === 0) {
        canvas.width = img.width;
        canvas.height = img.height;
        setImageSize({ width: img.width, height: img.height });
      }

      // Clear and draw base image
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      // Draw all elements
      const renderDrawing = (d) => {
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]); 
        
        if (d.tool === 'draw' && d.path) {
          ctx.beginPath();
          ctx.moveTo(d.path[0].x, d.path[0].y);
          d.path.forEach(p => ctx.lineTo(p.x, p.y));
          ctx.stroke();
        } else if (d.tool === 'circle') {
          ctx.beginPath();
          const rx = Math.abs(d.endX - d.startX) / 2;
          const ry = Math.abs(d.endY - d.startY) / 2;
          const cx = Math.min(d.startX, d.endX) + rx;
          const cy = Math.min(d.startY, d.endY) + ry;
          ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
          ctx.stroke();
        } else if (d.tool === 'arrow') {
          const headlen = 20;
          const dx = d.endX - d.startX;
          const dy = d.endY - d.startY;
          const angle = Math.atan2(dy, dx);
          ctx.beginPath();
          ctx.moveTo(d.startX, d.startY);
          ctx.lineTo(d.endX, d.endY);
          ctx.lineTo(d.endX - headlen * Math.cos(angle - Math.PI / 6), d.endY - headlen * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(d.endX, d.endY);
          ctx.lineTo(d.endX - headlen * Math.cos(angle + Math.PI / 6), d.endY - headlen * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        } else if (d.tool === 'dotted-line') {
          ctx.beginPath();
          ctx.setLineDash([15, 15]);
          if (d.path && d.path.length > 0) {
            ctx.moveTo(d.path[0].x, d.path[0].y);
            d.path.forEach(p => ctx.lineTo(p.x, p.y));
          }
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (d.tool === 'text') {
          const size = d.fontSize || 24;
          ctx.font = `bold ${size}px sans-serif`;
          ctx.fillStyle = d.color;
          ctx.textBaseline = 'top';
          ctx.textAlign = 'left';
          
          ctx.lineWidth = Math.max(2, size / 15);
          ctx.strokeStyle = d.color === '#ffffff' ? '#000000' : '#ffffff';
          
          const rawWidth = ctx.measureText(d.text).width;
          const drawBoxWidth = d.boxWidth || (rawWidth + 5);
          
          // Word Wrapping Logic
          const words = d.text.split(' ');
          const lines = [];
          let currentLine = words[0] || '';

          for (let i = 1; i < words.length; i++) {
              const word = words[i];
              const testWidth = ctx.measureText(currentLine + " " + word).width;
              if (testWidth <= drawBoxWidth) {
                  currentLine += " " + word;
              } else {
                  lines.push(currentLine);
                  currentLine = word;
              }
          }
          if (currentLine) lines.push(currentLine);

          const lineHeight = size * 1.2;
          lines.forEach((line, index) => {
              const lineY = d.startY + (index * lineHeight);
              ctx.strokeText(line, d.startX, lineY);
              ctx.fillText(line, d.startX, lineY);
          });

          const totalHeight = lines.length * lineHeight;

          // Draw selection box and resize handles if selected and in move mode
          if (d.id === selectedId && tool === 'none') {
            // Outline Box
            ctx.beginPath();
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#3b82f6'; 
            ctx.rect(d.startX - 4, d.startY - 4, drawBoxWidth + 8, totalHeight + 8);
            ctx.stroke();
            ctx.setLineDash([]);

            // 1. Font Scale Handle (Bottom Right Corner)
            ctx.fillStyle = '#3b82f6';
            ctx.fillRect(d.startX + drawBoxWidth - 4, d.startY + totalHeight - 4, 12, 12);
            
            // 2. Width Wrap Handle (Right Edge Center)
            ctx.fillStyle = '#3b82f6';
            ctx.fillRect(d.startX + drawBoxWidth - 4, d.startY + (totalHeight / 2) - 12, 8, 24);
          }
        }
      };

      drawings.forEach(renderDrawing);
      if (currentDrawing) renderDrawing(currentDrawing);
    };
    img.src = analysis.compositeImage;
  }, [analysis.compositeImage, drawings, currentDrawing, imageSize.width, selectedId, tool]);

  const getCoordinates = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };

  const handlePointerDown = (e) => {
    const coords = getCoordinates(e);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    let hit = null;

    // Check hits in reverse order (top elements first)
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.tool === 'text') {
        ctx.font = `bold ${d.fontSize || 24}px sans-serif`;
        const rawWidth = ctx.measureText(d.text).width;
        const drawBoxWidth = d.boxWidth || (rawWidth + 5);
        
        const words = d.text.split(' ');
        const lines = [];
        let currentLine = words[0] || '';
        for (let j = 1; j < words.length; j++) {
            const word = words[j];
            if (ctx.measureText(currentLine + " " + word).width <= drawBoxWidth) {
                currentLine += " " + word;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        if (currentLine) lines.push(currentLine);
        const totalHeight = lines.length * ((d.fontSize || 24) * 1.2);

        const hX = d.startX + drawBoxWidth;
        const hY = d.startY + totalHeight;
        const handleSize = 15;

        // 1. Check handles FIRST (only if this item is currently selected)
        if (d.id === selectedId) {
          if (coords.x >= hX - handleSize && coords.x <= hX + handleSize &&
              coords.y >= hY - handleSize && coords.y <= hY + handleSize) {
            hit = { id: d.id, type: 'scale', d, drawBoxWidth, totalHeight };
            break;
          }
          const rcY = d.startY + (totalHeight / 2);
          if (coords.x >= hX - handleSize && coords.x <= hX + handleSize &&
              coords.y >= rcY - handleSize && coords.y <= rcY + handleSize) {
            hit = { id: d.id, type: 'width', d, drawBoxWidth, totalHeight };
            break;
          }
        }

        // 2. Check body (for move or selecting)
        if (coords.x >= d.startX - 10 && coords.x <= d.startX + drawBoxWidth + 10 &&
            coords.y >= d.startY - 10 && coords.y <= d.startY + totalHeight + 10) {
          hit = { id: d.id, type: 'move', d, drawBoxWidth, totalHeight };
          break;
        }
      }
    }

    if (tool === 'none' || tool === 'text') {
      if (hit) {
        e.preventDefault(); 
        
        const now = Date.now();
        const isDoubleClick = (now - lastClickRef.current.time < 300) && (lastClickRef.current.id === hit.id);
        lastClickRef.current = { time: now, id: hit.id };

        setSelectedId(hit.id);

        // Edit Mode Triggers: Double click in Move mode, or Single click in Text mode
        if (tool === 'text' || isDoubleClick) {
          setTextInput({ active: true, coords: { x: hit.d.startX, y: hit.d.startY }, text: hit.d.text, editingId: hit.id });
          setTool('none'); 
          return;
        }

        setInteraction({ 
          type: hit.type, 
          id: hit.id, 
          offX: coords.x - hit.d.startX, 
          offY: coords.y - hit.d.startY,
          startFontSize: hit.d.fontSize || 24,
          startHeight: hit.totalHeight,
          startBoxWidth: hit.drawBoxWidth,
          startX: coords.x
        });
        return;
      } else {
        if (tool === 'none') {
          e.preventDefault();
          setSelectedId(null);
          setInteraction(null);
          lastClickRef.current = { time: 0, id: null };
          return;
        }
      }
    }

    e.preventDefault();

    if (tool === 'text') {
      setTextInput({ active: true, coords: { x: coords.x, y: coords.y }, text: '', editingId: null });
      return;
    }

    setCurrentDrawing({ id: Date.now(), tool, color, startX: coords.x, startY: coords.y, endX: coords.x, endY: coords.y, path: [coords] });
  };

  const handlePointerMove = (e) => {
    // Handle Moving or Resizing Selected Text
    if (tool === 'none' && interaction) {
      e.preventDefault();
      const coords = getCoordinates(e);
      setDrawings(prev => prev.map(d => {
        if (d.id === interaction.id) {
          if (interaction.type === 'move') {
            return { ...d, startX: coords.x - interaction.offX, startY: coords.y - interaction.offY };
          } else if (interaction.type === 'scale') {
            const newHeight = Math.max(15, coords.y - d.startY);
            const scaleRatio = newHeight / interaction.startHeight;
            const newSize = Math.max(10, interaction.startFontSize * scaleRatio);
            return { ...d, fontSize: newSize };
          } else if (interaction.type === 'width') {
            const newWidth = Math.max(40, interaction.startBoxWidth + (coords.x - interaction.startX));
            return { ...d, boxWidth: newWidth };
          }
        }
        return d;
      }));
      return;
    }

    // Normal drawing mechanics
    if (!currentDrawing) return;
    e.preventDefault();
    const coords = getCoordinates(e);
    if (tool === 'draw' || tool === 'dotted-line') {
      setCurrentDrawing(prev => ({ ...prev, path: [...prev.path, coords] }));
    } else {
      setCurrentDrawing(prev => ({ ...prev, endX: coords.x, endY: coords.y }));
    }
  };

  const handlePointerUp = () => {
    // End text interaction
    if (tool === 'none' && interaction) {
      setInteraction(null);
      return;
    }
    // Commit new drawing
    if (currentDrawing) {
      setDrawings(prev => [...prev, currentDrawing]);
      setCurrentDrawing(null);
    }
  };

  const handleDownload = () => {
    // Deselect before download so blue boxes aren't saved
    setSelectedId(null); 
    setTimeout(() => {
      const canvas = canvasRef.current;
      const url = canvas.toDataURL('image/jpeg', 0.9);
      const a = document.createElement('a');
      a.href = url;
      a.download = `progress-report-${analysis.viewType}.jpg`;
      a.click();
    }, 50);
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden group">
      <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex justify-between items-center">
        <div className="flex items-center gap-2 text-slate-600">
          <Calendar size={16} />
          <span className="font-medium text-sm capitalize">{analysis.viewType} View • {new Date(analysis.date).toLocaleDateString()}</span>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={handleDownload}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Download size={16} /> Download
          </button>
          <button onClick={onDelete} className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button>
        </div>
      </div>
      
      {/* Drawing Toolbar */}
      <div className="px-6 py-3 bg-white border-b border-slate-100 flex items-center justify-between">
        <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
          {[
            { id: 'none', icon: MousePointer2, label: 'Move / Resize Text' },
            { id: 'arrow', icon: ArrowUpRight, label: 'Arrow' },
            { id: 'circle', icon: CircleIcon, label: 'Circle' },
            { id: 'draw', icon: PenLine, label: 'Draw' },
            { id: 'dotted-line', icon: Activity, label: 'Dotted Curve' },
            { id: 'text', icon: Type, label: 'Add Text' }
          ].map(t => (
            <button
              key={t.id}
              onClick={() => { setTool(t.id); setSelectedId(null); }}
              className={`p-2 rounded-md transition-colors ${tool === t.id ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'}`}
              title={t.label}
            >
              <t.icon size={18} />
            </button>
          ))}
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex gap-1.5 items-center bg-slate-100 p-1.5 rounded-lg">
            {colors.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded-full border-2 transition-transform ${color === c ? 'border-slate-800 scale-110' : 'border-transparent hover:scale-110'}`}
                style={{ backgroundColor: c, boxShadow: c === '#ffffff' ? 'inset 0 0 0 1px #e2e8f0' : 'none' }}
              />
            ))}
          </div>
          <div className="flex gap-1">
            <button 
              onClick={() => { setDrawings(prev => prev.slice(0, -1)); setSelectedId(null); }}
              disabled={drawings.length === 0}
              className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors disabled:opacity-50"
              title="Undo"
            >
              <Undo size={18} />
            </button>
            <button 
              onClick={() => { setDrawings([]); setSelectedId(null); }}
              disabled={drawings.length === 0}
              className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
              title="Clear All"
            >
              <Eraser size={18} />
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 bg-slate-100 flex justify-center relative">
        
        {/* Custom Text Input Modal Overlay */}
        {textInput.active && (
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-10 rounded-b-2xl">
            <div 
              className="bg-white p-6 rounded-2xl shadow-xl w-80 max-w-[90%] border border-slate-200" 
              onClick={e => e.stopPropagation()}
            >
              <h4 className="text-lg font-bold mb-4 text-slate-800">
                {textInput.editingId ? 'Edit Text Label' : 'Add Text Label'}
              </h4>
              <input
                type="text"
                autoFocus
                className="w-full border border-slate-300 rounded-xl p-3 focus:ring-2 focus:ring-indigo-500 mb-4 text-slate-800"
                placeholder="Enter your text here..."
                value={textInput.text}
                onChange={(e) => setTextInput(prev => ({ ...prev, text: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (textInput.text.trim()) {
                      if (textInput.editingId) {
                        setDrawings(prev => prev.map(d => d.id === textInput.editingId ? { ...d, text: textInput.text.trim(), color: color } : d));
                        setSelectedId(textInput.editingId);
                      } else {
                        const newId = Date.now();
                        setDrawings(prev => [...prev, {
                          id: newId,
                          tool: 'text',
                          color: color,
                          text: textInput.text.trim(),
                          startX: textInput.coords.x,
                          startY: textInput.coords.y,
                          fontSize: 24
                        }]);
                        setSelectedId(newId);
                      }
                      setTool('none'); 
                    }
                    setTextInput({ active: false, coords: null, text: '', editingId: null });
                  }
                  if (e.key === 'Escape') setTextInput({ active: false, coords: null, text: '', editingId: null });
                }}
              />
              <div className="flex justify-end gap-3">
                <button 
                  onClick={() => setTextInput({ active: false, coords: null, text: '', editingId: null })} 
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl font-medium transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    if (textInput.text.trim()) {
                      if (textInput.editingId) {
                        setDrawings(prev => prev.map(d => d.id === textInput.editingId ? { ...d, text: textInput.text.trim(), color: color } : d));
                        setSelectedId(textInput.editingId);
                      } else {
                        const newId = Date.now();
                        setDrawings(prev => [...prev, {
                          id: newId,
                          tool: 'text',
                          color: color,
                          text: textInput.text.trim(),
                          startX: textInput.coords.x,
                          startY: textInput.coords.y,
                          fontSize: 24
                        }]);
                        setSelectedId(newId);
                      }
                      setTool('none'); 
                    }
                    setTextInput({ active: false, coords: null, text: '', editingId: null });
                  }} 
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors shadow-sm"
                >
                  {textInput.editingId ? 'Save Changes' : 'Add Text'}
                </button>
              </div>
            </div>
          </div>
        )}

        <canvas 
          ref={canvasRef}
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
          style={{ touchAction: 'none' }}
          className={`max-h-[600px] w-auto object-contain rounded-xl shadow-md border border-slate-200 ${tool !== 'none' ? 'cursor-crosshair' : 'cursor-default'}`}
        />
      </div>
    </div>
  );
}
