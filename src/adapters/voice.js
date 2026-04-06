import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

export class VoiceAdapter {
  constructor(aiEngine) {
    this.ai = aiEngine;
    this.enabled = false;
    this.tempDir = './data/voice-temp';
  }

  initialize() {
    const voiceEnabled = process.env.VOICE_ENABLED !== 'false';
    if (!voiceEnabled) {
      console.log('  ⚠ Voice: Disabled in configuration');
      return false;
    }
    this.enabled = true;
    console.log('  ✓ Voice engine ready');
    return true;
  }

  async transcribe(audioBuffer, mimeType = 'audio/webm') {
    if (!this.enabled) throw new Error('Voice is not enabled');

    try {
      const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') ? 'mp4' : 'webm';
      const text = await this.ai.transcribeAudio(audioBuffer, `recording.${ext}`);
      return { text, success: true };
    } catch (error) {
      console.error('Transcription error:', error.message);
      return { text: '', success: false, error: error.message };
    }
  }

  async synthesize(text, options = {}) {
    if (!this.enabled) throw new Error('Voice is not enabled');

    try {
      const audioBuffer = await this.ai.textToSpeech(text, {
        voice: options.voice || process.env.VOICE_NAME || 'alloy',
        model: options.model || process.env.VOICE_MODEL || 'tts-1'
      });
      return { audio: audioBuffer, success: true, contentType: 'audio/mpeg' };
    } catch (error) {
      console.error('TTS error:', error.message);
      return { audio: null, success: false, error: error.message };
    }
  }
}

export default VoiceAdapter;
