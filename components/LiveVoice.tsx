import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, X, Settings2, Sparkles, AlertCircle, Loader2 } from 'lucide-react';
import { createBlob, decode, decodeAudioData } from '../utils/audioUtils';

// --- API CONFIGURATION ---
// 1. Get your API key from https://aistudio.google.com/
// 2. Ideally set it in your environment as process.env.API_KEY
// 3. For quick local testing, you can paste it directly below (e.g., const API_KEY = "AIzaSy...")
const API_KEY = "AIzaSyA-xohm0ypwS_bjcSeuj3VK7nm2cIht2Zg";

export const LiveVoice: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  
  // Default instruction specifically requested by user
  const [systemInstruction, setSystemInstruction] = useState("You are a helpful, witty, and concise AI assistant. Respond naturally and conversationally. IMPORTANT: As soon as the session starts, you MUST say 'Hello there! We can start.'");
  const [error, setError] = useState<string | null>(null);

  // Visual State (decoupled from audio loop for performance)
  const [visualVolume, setVisualVolume] = useState(0);

  // Audio Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  // Logic Refs
  const currentVolumeRef = useRef(0); // Instantaneous volume
  const animationFrameRef = useRef<number | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const aiRef = useRef<GoogleGenAI | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);

  // --- AUDIO CLEANUP ---
  const cleanupAudio = useCallback(() => {
    // 1. Stop Animation Loop
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // 2. Stop all playing sources
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
    });
    sourcesRef.current.clear();

    // 3. Stop Input Stream (Mic)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // 4. Disconnect Nodes
    if (inputSourceRef.current) {
        try { inputSourceRef.current.disconnect(); } catch (e) {}
    }
    if (processorRef.current) {
        try { processorRef.current.disconnect(); } catch (e) {}
    }
    
    // 5. Close Contexts
    if (inputAudioContextRef.current?.state !== 'closed') inputAudioContextRef.current?.close();
    if (outputAudioContextRef.current?.state !== 'closed') outputAudioContextRef.current?.close();
    
    inputAudioContextRef.current = null;
    outputAudioContextRef.current = null;
    nextStartTimeRef.current = 0;
    sessionPromiseRef.current = null;
    
    // 6. Reset State
    setIsAiSpeaking(false);
    setVisualVolume(0);
    currentVolumeRef.current = 0;
    setIsConnecting(false);
  }, []);

  const disconnectSession = useCallback(async () => {
    if (sessionPromiseRef.current) {
        try {
            const session = await sessionPromiseRef.current;
            session.close();
        } catch (e) {
            console.error("Error closing session:", e);
        }
    }
    cleanupAudio();
    setIsActive(false);
  }, [cleanupAudio]);

  // --- VISUAL LOOP ---
  // Optimized: Separate render loop from audio processing loop
  const startVisualLoop = useCallback(() => {
    const update = () => {
      // Smooth interpolation for the visual volume
      // Move visualVolume 20% closer to currentVolumeRef each frame
      setVisualVolume(prev => prev + (currentVolumeRef.current - prev) * 0.2);
      animationFrameRef.current = requestAnimationFrame(update);
    };
    update();
  }, []);

  // --- CONNECTION LOGIC ---
  const connectSession = async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    setError(null);

    try {
      // Check for API Key
      if (!API_KEY) {
        throw new Error("API Key is missing. Please check the code in LiveVoice.tsx to set your API_KEY.");
      }
      
      aiRef.current = new GoogleGenAI({ apiKey: API_KEY });

      // Initialize Audio Contexts
      // We use 16kHz for input to match Gemini Live requirements
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
      
      const outputNode = outputAudioContextRef.current.createGain();
      outputNode.connect(outputAudioContextRef.current.destination);
      outputNodeRef.current = outputNode;

      // Request Mic Permissions with optimization constraints
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        } 
      });
      streamRef.current = stream;

      // Start Session
      const sessionPromise = aiRef.current.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: systemInstruction,
        },
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsActive(true);
            startVisualLoop();

            if (!inputAudioContextRef.current || !streamRef.current) return;
            
            const source = inputAudioContextRef.current.createMediaStreamSource(streamRef.current);
            inputSourceRef.current = source;
            
            // Use ScriptProcessor for raw PCM access (AudioWorklet is better but more complex to setup in this single-file context)
            const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            processorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              if (!isMicOn) {
                  currentVolumeRef.current = 0;
                  return;
              }

              const inputData = e.inputBuffer.getChannelData(0);
              
              // Calculate RMS volume for visuals (very fast)
              let sum = 0;
              for(let i=0; i<inputData.length; i+=4) { // Sample every 4th point for speed
                  sum += inputData[i] * inputData[i];
              }
              const rms = Math.sqrt(sum / (inputData.length / 4));
              
              // Update ref, NOT state, to avoid React thrashing
              currentVolumeRef.current = Math.min(rms * 5, 1); // Boost and clamp

              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current && outputNodeRef.current) {
                const ctx = outputAudioContextRef.current;
                if(ctx.state === 'suspended') await ctx.resume();

                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                
                const audioBuffer = await decodeAudioData(
                    decode(base64Audio),
                    ctx,
                    24000,
                    1
                );
                
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputNodeRef.current);
                
                source.addEventListener('ended', () => {
                   sourcesRef.current.delete(source);
                   if (sourcesRef.current.size === 0) setIsAiSpeaking(false);
                });
                
                setIsAiSpeaking(true);
                source.start(nextStartTimeRef.current);
                sourcesRef.current.add(source);
                nextStartTimeRef.current += audioBuffer.duration;
            }

            // Interruption handling
            if (message.serverContent?.interrupted) {
                sourcesRef.current.forEach(s => s.stop());
                sourcesRef.current.clear();
                nextStartTimeRef.current = 0;
                setIsAiSpeaking(false);
            }
          },
          onclose: () => {
            setIsActive(false);
            setIsAiSpeaking(false);
            setIsConnecting(false);
          },
          onerror: (err) => {
            console.error(err);
            setError('Connection failed. Please try again.');
            disconnectSession();
          }
        }
      });
      sessionPromiseRef.current = sessionPromise;

    } catch (e: any) {
      console.error(e);
      setError(e.message || 'Failed to start audio session.');
      cleanupAudio();
      setIsConnecting(false);
    }
  };

  const toggleMic = () => {
    setIsMicOn(prev => !prev);
  };

  useEffect(() => {
    return () => {
        disconnectSession();
    };
  }, [disconnectSession]);


  // --- STYLES FOR BLOB ---
  const blobStyles = `
    @keyframes morph {
      0% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; }
      50% { border-radius: 30% 60% 70% 40% / 50% 60% 30% 60%; }
      100% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; }
    }
    @keyframes slow-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .animate-morph {
      animation: morph 8s ease-in-out infinite alternate;
    }
    .animate-morph-fast {
      animation: morph 3s ease-in-out infinite alternate;
    }
    .animate-slow-spin {
      animation: slow-spin 20s linear infinite;
    }
  `;

  return (
    <div className="relative h-full w-full flex flex-col items-center justify-center bg-slate-950 overflow-hidden font-sans selection:bg-blue-500/30">
      <style>{blobStyles}</style>

      {/* SETUP SCREEN */}
      {!isActive && (
        <div className="z-20 w-full max-w-sm px-6 flex flex-col items-center animate-in fade-in zoom-in duration-500">
          
          <div className="mb-8 relative group cursor-default">
             <div className="absolute inset-0 bg-blue-500 rounded-full blur-2xl opacity-20 group-hover:opacity-30 transition-opacity duration-500"></div>
             <div className="relative bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-2xl">
                <Sparkles className="w-8 h-8 text-blue-400" />
             </div>
          </div>

          <h1 className="text-2xl font-semibold text-white mb-2 tracking-tight text-center">Gemini Live</h1>
          <p className="text-slate-400 mb-8 text-center text-sm">Experience real-time voice conversation.</p>

          <div className="w-full space-y-4">
             <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 transition-all focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/50 hover:border-slate-700">
               <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                 <Settings2 size={12} /> System Instruction
               </label>
               <textarea
                 value={systemInstruction}
                 onChange={(e) => setSystemInstruction(e.target.value)}
                 className="w-full bg-transparent text-slate-200 text-sm focus:outline-none resize-none h-24 placeholder-slate-600 leading-relaxed scrollbar-hide"
                 placeholder="E.g., You are a strict tutor, or a funny pirate..."
               />
             </div>

             <button
               onClick={connectSession}
               disabled={isConnecting}
               className="w-full py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium text-sm hover:shadow-lg hover:shadow-blue-500/25 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
             >
               {isConnecting ? (
                 <>
                   <Loader2 size={18} className="animate-spin" /> Connecting...
                 </>
               ) : (
                 "Start Conversation"
               )}
             </button>
          </div>
          
          {error && (
            <div className="mt-6 flex items-start gap-2 text-red-400 bg-red-950/20 px-4 py-3 rounded-lg border border-red-900/30 text-xs">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <p>{error}</p>
            </div>
          )}
        </div>
      )}

      {/* ACTIVE SCREEN */}
      {isActive && (
        <div className="relative w-full h-full flex flex-col items-center justify-center animate-in fade-in duration-700">
          
          {/* Status Pill */}
          <div className="absolute top-12 left-0 right-0 flex justify-center z-10">
              <div className={`
                flex items-center gap-2 px-5 py-2.5 rounded-full border backdrop-blur-md transition-all duration-500
                ${isAiSpeaking 
                    ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200 shadow-lg shadow-indigo-500/10' 
                    : 'border-slate-700/50 bg-slate-900/40 text-slate-300'
                }
              `}>
                  <div className={`w-2 h-2 rounded-full transition-colors duration-300 ${isAiSpeaking ? 'bg-indigo-400 animate-pulse' : (isMicOn ? 'bg-emerald-400' : 'bg-slate-500')}`}></div>
                  <span className="text-xs font-medium tracking-wide">
                    {isAiSpeaking ? 'GEMINI SPEAKING' : (isMicOn ? 'LISTENING' : 'MUTED')}
                  </span>
              </div>
          </div>

          {/* THE LIVING ORB */}
          <div className="relative flex items-center justify-center w-full h-[60vh]">
             
             {/* Dynamic Glow */}
             <div 
                className={`absolute transition-all duration-700 ease-out blur-[120px] rounded-full mix-blend-screen
                ${isAiSpeaking ? 'w-[400px] h-[400px] bg-indigo-600/20' : 'w-[300px] h-[300px] bg-blue-600/10'}`}
             ></div>

             {/* Core Blob */}
             <div 
               className={`relative shadow-2xl transition-all duration-200 ease-out animate-morph
                 ${isAiSpeaking 
                   ? 'w-72 h-72 bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 animate-morph-fast saturate-150' 
                   : 'w-64 h-64 bg-gradient-to-br from-slate-700 via-blue-900 to-slate-800'
                 }
               `}
               style={{
                 // Visual Volume Reaction
                 // When user speaks: Expand significantly
                 // When AI speaks: Slight pulse (handled by CSS morph-fast), but we keep scale mostly stable
                 transform: !isAiSpeaking && isMicOn 
                    ? `scale(${1 + visualVolume * 1.5})` 
                    : isAiSpeaking
                        ? `scale(${1 + visualVolume * 0.2})` // Subtle reaction to own voice
                        : 'scale(1)',
                 boxShadow: isAiSpeaking 
                    ? `0 0 ${40 + visualVolume * 50}px rgba(99, 102, 241, 0.4)`
                    : `0 0 ${20 + visualVolume * 50}px rgba(59, 130, 246, 0.2)`
               }}
             >
                {/* Texture/Sheen Overlays */}
                <div className="absolute inset-0 rounded-[inherit] bg-gradient-to-t from-transparent via-white/10 to-transparent opacity-30 animate-slow-spin"></div>
                <div className="absolute inset-0 rounded-[inherit] shadow-[inset_0_0_40px_rgba(0,0,0,0.3)]"></div>
             </div>

          </div>

          {/* Bottom Controls */}
          <div className="absolute bottom-12 flex items-center gap-6 z-10">
             <button 
               onClick={toggleMic}
               className={`p-4 rounded-full backdrop-blur-xl border transition-all duration-300 transform hover:scale-105 active:scale-95 ${
                 isMicOn 
                   ? 'bg-slate-800/60 border-slate-700 text-white hover:bg-slate-700/80' 
                   : 'bg-white text-slate-900 border-white hover:bg-slate-200'
               }`}
               aria-label={isMicOn ? "Mute Microphone" : "Unmute Microphone"}
             >
               {isMicOn ? <Mic size={24} /> : <MicOff size={24} />}
             </button>
             
             <button 
               onClick={disconnectSession}
               className="group p-4 rounded-full bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500 hover:text-white hover:border-red-500 transition-all duration-300 transform hover:scale-105 active:scale-95"
               aria-label="End Conversation"
             >
               <X size={24} className="group-hover:rotate-90 transition-transform duration-300" />
             </button>
          </div>

        </div>
      )}
    </div>
  );
};
