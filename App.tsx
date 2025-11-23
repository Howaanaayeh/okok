import React from 'react';
import { LiveVoice } from './components/LiveVoice';

const App: React.FC = () => {
  return (
    <div className="h-screen w-full bg-slate-950 text-white overflow-hidden">
      <LiveVoice />
    </div>
  );
};

export default App;