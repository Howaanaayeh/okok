export interface ModelConfig {
  modelName: string;
  displayName: string;
  description: string;
  color: 'blue' | 'purple' | 'amber' | 'green';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
  isStreaming?: boolean;
}
