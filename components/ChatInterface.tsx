import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Chat, GenerateContentResponse } from '@google/genai';
import { Send, Loader2, User, Bot, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { ModelConfig, ChatMessage } from '../types';

interface ChatInterfaceProps {
  config: ModelConfig;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ config }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Gemini Instance Refs
  const aiRef = useRef<GoogleGenAI | null>(null);
  const chatRef = useRef<Chat | null>(null);

  // Initialize Gemini
  useEffect(() => {
    if (!process.env.API_KEY) return;
    
    aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // Create Chat Session
    // Note: Flash Lite might behave better as generateContent for single turns, 
    // but chat.sendMessage is fine if we manage history or let SDK handle it.
    // For "Fast Responses", often a fresh context is okay, but continuous chat is better UX.
    chatRef.current = aiRef.current.chats.create({
      model: config.modelName,
      config: {
        // Higher temperature for chat, lower for flash lite if we wanted strictness, but let's keep default
      }
    });

  }, [config.modelName]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !chatRef.current || isLoading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: input,
      timestamp: new Date()
    };

    const tempBotMessageId = (Date.now() + 1).toString();
    const tempBotMessage: ChatMessage = {
      id: tempBotMessageId,
      role: 'model',
      text: '',
      timestamp: new Date(),
      isStreaming: true
    };

    setMessages(prev => [...prev, userMessage, tempBotMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const resultStream = await chatRef.current.sendMessageStream({ message: userMessage.text });
      
      let fullText = '';
      
      for await (const chunk of resultStream) {
        const c = chunk as GenerateContentResponse;
        if (c.text) {
          fullText += c.text;
          setMessages(prev => 
            prev.map(msg => 
              msg.id === tempBotMessageId 
                ? { ...msg, text: fullText } 
                : msg
            )
          );
        }
      }
      
      setMessages(prev => 
        prev.map(msg => 
          msg.id === tempBotMessageId 
            ? { ...msg, isStreaming: false } 
            : msg
        )
      );

    } catch (error: any) {
      console.error(error);
      setMessages(prev => 
        prev.map(msg => 
          msg.id === tempBotMessageId 
            ? { ...msg, text: `Error: ${error.message || 'Something went wrong.'}`, isStreaming: false } 
            : msg
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const getThemeColors = () => {
    switch (config.color) {
      case 'purple': return 'bg-purple-600 hover:bg-purple-700 text-white';
      case 'amber': return 'bg-amber-600 hover:bg-amber-700 text-white';
      default: return 'bg-blue-600 hover:bg-blue-700 text-white';
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${config.color === 'purple' ? 'bg-purple-500/20 text-purple-400' : 'bg-amber-500/20 text-amber-400'}`}>
                {config.color === 'purple' ? <Bot size={24} /> : <Sparkles size={24} />}
            </div>
            <div>
                <h2 className="font-semibold text-lg text-white">{config.displayName}</h2>
                <p className="text-xs text-slate-400">{config.description}</p>
            </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 opacity-60">
            <Bot size={48} className="mb-4 opacity-50" />
            <p>Start a conversation with {config.displayName}</p>
          </div>
        )}
        
        {messages.map((msg) => (
          <div 
            key={msg.id} 
            className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'model' && (
              <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center mt-1 ${
                  config.color === 'purple' ? 'bg-purple-600' : 'bg-amber-600'
              }`}>
                <Bot size={16} className="text-white" />
              </div>
            )}
            
            <div 
              className={`max-w-[80%] rounded-2xl px-5 py-3.5 shadow-sm ${
                msg.role === 'user' 
                  ? 'bg-slate-700 text-white rounded-br-none' 
                  : 'bg-slate-800 border border-slate-700 text-slate-200 rounded-bl-none'
              }`}
            >
              <div className="prose prose-invert prose-sm max-w-none leading-relaxed">
                <ReactMarkdown>{msg.text}</ReactMarkdown>
              </div>
              {msg.isStreaming && (
                <div className="mt-2 flex gap-1">
                  <div className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                  <div className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                  <div className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                </div>
              )}
            </div>

            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-slate-600 flex-shrink-0 flex items-center justify-center mt-1">
                <User size={16} className="text-slate-300" />
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-4 bg-slate-900 border-t border-slate-800">
        <form onSubmit={handleSubmit} className="relative max-w-4xl mx-auto">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message ${config.displayName}...`}
            className="w-full bg-slate-800 text-white placeholder-slate-400 border border-slate-700 rounded-xl pl-5 pr-14 py-4 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all shadow-lg"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className={`absolute right-2 top-2 bottom-2 aspect-square rounded-lg flex items-center justify-center transition-colors ${
              !input.trim() || isLoading 
                ? 'text-slate-600 bg-transparent cursor-not-allowed' 
                : `${getThemeColors()}`
            }`}
          >
            {isLoading ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
          </button>
        </form>
        <div className="text-center mt-2">
            <p className="text-[10px] text-slate-600">
                AI can make mistakes. Check important info.
            </p>
        </div>
      </div>
    </div>
  );
};
