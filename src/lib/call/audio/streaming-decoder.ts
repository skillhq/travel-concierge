/**
 * Streaming MP3 to µ-law decoder using ffmpeg
 * Converts MP3 audio chunks to 8kHz µ-law in real-time
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface StreamingDecoderEvents {
  data: (mulaw: Buffer) => void;
  error: (error: Error) => void;
  close: () => void;
}

/**
 * Streaming MP3 to µ-law decoder
 * Uses ffmpeg subprocess with pipes for real-time conversion
 */
export class StreamingDecoder extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private isStarted = false;

  /**
   * Start the decoder
   * Must be called before writing data
   */
  start(): void {
    if (this.isStarted) {
      return;
    }

    // Spawn ffmpeg to convert MP3 (stdin) to µ-law (stdout)
    this.ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',           // Read MP3 from stdin
      '-f', 'mulaw',            // Output format: µ-law
      '-ar', '8000',            // 8kHz sample rate (Twilio)
      '-ac', '1',               // Mono
      'pipe:1',                 // Write to stdout
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle µ-law output
    this.ffmpeg.stdout?.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    // Handle errors
    this.ffmpeg.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('size=')) {
        console.error('[StreamingDecoder] ffmpeg:', msg);
      }
    });

    this.ffmpeg.on('error', (err) => {
      this.emit('error', err);
    });

    this.ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[StreamingDecoder] ffmpeg exited with code ${code}`);
      }
      this.ffmpeg = null;
      this.isStarted = false;
      this.emit('close');
    });

    this.isStarted = true;
  }

  /**
   * Write MP3 data to the decoder
   * Converted µ-law will be emitted via 'data' events
   */
  write(mp3Data: Buffer): boolean {
    if (!this.ffmpeg?.stdin?.writable) {
      return false;
    }

    try {
      return this.ffmpeg.stdin.write(mp3Data);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /**
   * Signal end of input and flush remaining data
   */
  end(): void {
    if (this.ffmpeg?.stdin) {
      this.ffmpeg.stdin.end();
    }
  }

  /**
   * Stop the decoder immediately
   */
  stop(): void {
    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
      this.isStarted = false;
    }
  }

  /**
   * Check if decoder is running
   */
  get running(): boolean {
    return this.isStarted && this.ffmpeg !== null;
  }
}

/**
 * Create a streaming decoder for TTS audio
 */
export function createStreamingDecoder(): StreamingDecoder {
  return new StreamingDecoder();
}
