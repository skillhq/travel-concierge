/**
 * Eval runner for testing the voice pipeline without a real phone call
 *
 * Pipeline being tested:
 * 1. Generate human speech audio (macOS say → PCM)
 * 2. Send to Deepgram STT
 * 3. Send transcript to Claude AI
 * 4. Send AI response to ElevenLabs TTS
 * 5. Receive µ-law audio (measure quality/duration)
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { ConversationScript } from './conversation-scripts.js';
import { ConversationAI } from '../conversation-ai.js';

export interface EvalConfig {
  anthropicApiKey: string;
  deepgramApiKey: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  /** Directory to save results */
  outputDir?: string;
  /** Whether to play audio during eval */
  playAudio?: boolean;
  /** Whether to save audio files */
  saveAudio?: boolean;
}

export interface TurnMetrics {
  turnIndex: number;
  humanText: string;
  humanAudioDurationMs: number;
  sttLatencyMs: number;
  sttTranscript: string;
  sttConfidence: number;
  aiLatencyMs: number;
  aiResponse: string;
  ttsLatencyMs: number;
  ttsFirstByteMs: number;
  ttsAudioDurationMs: number;
  totalTurnLatencyMs: number;
}

export interface EvalResult {
  scriptId: string;
  scriptName: string;
  goal: string;
  timestamp: string;
  success: boolean;
  error?: string;
  turns: TurnMetrics[];
  summary: {
    totalTurns: number;
    completedTurns: number;
    avgSttLatencyMs: number;
    avgAiLatencyMs: number;
    avgTtsLatencyMs: number;
    avgTotalLatencyMs: number;
    conversationComplete: boolean;
  };
}

/**
 * Generate speech audio using macOS say command
 * Returns PCM audio buffer at 8kHz 16-bit mono
 */
async function generateSpeechAudio(text: string): Promise<{ pcm: Buffer; durationMs: number }> {
  const tempAiff = join(tmpdir(), `eval_speech_${Date.now()}.aiff`);
  const tempPcm = join(tmpdir(), `eval_speech_${Date.now()}.pcm`);

  try {
    // Generate speech with macOS say
    execSync(`say -o "${tempAiff}" "${text.replace(/"/g, '\\"')}"`, { stdio: 'pipe' });

    // Convert to 8kHz 16-bit PCM (same as Twilio)
    execSync(`ffmpeg -y -i "${tempAiff}" -f s16le -ar 8000 -ac 1 "${tempPcm}" 2>/dev/null`, { stdio: 'pipe' });

    const pcm = readFileSync(tempPcm);
    const durationMs = (pcm.length / 2) / 8; // 16-bit = 2 bytes per sample, 8kHz

    return { pcm, durationMs };
  } finally {
    try { unlinkSync(tempAiff); } catch {}
    try { unlinkSync(tempPcm); } catch {}
  }
}

/**
 * Send audio to Deepgram and get transcript
 */
async function transcribeAudio(
  pcm: Buffer,
  apiKey: string,
): Promise<{ transcript: string; confidence: number; latencyMs: number }> {
  const startTime = Date.now();
  const deepgram = createClient(apiKey);

  return new Promise((resolve, reject) => {
    const connection = deepgram.listen.live({
      model: 'nova-2-phonecall',
      language: 'en-US',
      punctuate: true,
      interim_results: false,
      endpointing: 500,
      encoding: 'linear16',
      sample_rate: 8000,
      channels: 1,
    });

    let transcript = '';
    let confidence = 0;
    let firstTranscriptTime: number | null = null;

    connection.on(LiveTranscriptionEvents.Open, () => {
      // Send audio in chunks (simulating real-time)
      const CHUNK_SIZE = 320; // 20ms at 8kHz 16-bit
      let offset = 0;

      const sendChunk = () => {
        if (offset >= pcm.length) {
          // Wait a bit then close
          setTimeout(() => connection.requestClose(), 1000);
          return;
        }

        const chunk = pcm.slice(offset, offset + CHUNK_SIZE);
        const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        connection.send(ab as ArrayBuffer);
        offset += CHUNK_SIZE;

        setTimeout(sendChunk, 20); // Real-time pace
      };

      sendChunk();
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const text = data.channel?.alternatives?.[0]?.transcript || '';
      const conf = data.channel?.alternatives?.[0]?.confidence || 0;

      if (text && data.is_final) {
        if (!firstTranscriptTime) {
          firstTranscriptTime = Date.now();
        }
        transcript += text + ' ';
        confidence = Math.max(confidence, conf);
      }
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      const latencyMs = (firstTranscriptTime || Date.now()) - startTime;
      resolve({
        transcript: transcript.trim(),
        confidence,
        latencyMs,
      });
    });

    connection.on(LiveTranscriptionEvents.Error, (error) => {
      reject(error);
    });

    // Timeout
    setTimeout(() => {
      reject(new Error('Deepgram timeout'));
    }, 30000);
  });
}

/**
 * Get AI response
 */
async function getAIResponse(
  conversationAI: ConversationAI,
  humanSaid: string,
): Promise<{ response: string; latencyMs: number }> {
  const startTime = Date.now();
  const response = await conversationAI.respond(humanSaid);
  const latencyMs = Date.now() - startTime;

  return {
    response: response || '[CONVERSATION COMPLETE]',
    latencyMs,
  };
}

/**
 * Get TTS audio from ElevenLabs
 */
async function synthesizeSpeech(
  text: string,
  apiKey: string,
  voiceId: string,
): Promise<{ audio: Buffer; latencyMs: number; firstByteMs: number; durationMs: number }> {
  const startTime = Date.now();
  let firstByteTime: number | null = null;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        output_format: 'ulaw_8000',
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs error: ${response.status}`);
  }

  const chunks: Buffer[] = [];
  const reader = response.body!.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (!firstByteTime) {
      firstByteTime = Date.now();
    }
    chunks.push(Buffer.from(value));
  }

  const audio = Buffer.concat(chunks);
  const latencyMs = Date.now() - startTime;
  const firstByteMs = (firstByteTime || startTime) - startTime;
  const durationMs = (audio.length / 8000) * 1000; // 8kHz µ-law

  return { audio, latencyMs, firstByteMs, durationMs };
}

/**
 * Play audio using ffmpeg + afplay (macOS)
 */
function playMulawAudio(audio: Buffer): void {
  const tempUlaw = join(tmpdir(), `eval_play_${Date.now()}.ulaw`);
  const tempWav = join(tmpdir(), `eval_play_${Date.now()}.wav`);

  try {
    writeFileSync(tempUlaw, audio);
    execSync(`ffmpeg -y -f mulaw -ar 8000 -ac 1 -i "${tempUlaw}" "${tempWav}" 2>/dev/null`, { stdio: 'pipe' });
    execSync(`afplay "${tempWav}"`, { stdio: 'pipe' });
  } finally {
    try { unlinkSync(tempUlaw); } catch {}
    try { unlinkSync(tempWav); } catch {}
  }
}

/**
 * Run evaluation on a single script
 */
export async function runEval(
  script: ConversationScript,
  config: EvalConfig,
): Promise<EvalResult> {
  const result: EvalResult = {
    scriptId: script.id,
    scriptName: script.name,
    goal: script.goal,
    timestamp: new Date().toISOString(),
    success: false,
    turns: [],
    summary: {
      totalTurns: script.turns.length,
      completedTurns: 0,
      avgSttLatencyMs: 0,
      avgAiLatencyMs: 0,
      avgTtsLatencyMs: 0,
      avgTotalLatencyMs: 0,
      conversationComplete: false,
    },
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`EVAL: ${script.name}`);
  console.log(`Goal: ${script.goal}`);
  console.log(`${'='.repeat(60)}\n`);

  // Initialize conversation AI
  const conversationAI = new ConversationAI({
    apiKey: config.anthropicApiKey,
    goal: script.goal,
    context: script.context,
  });

  try {
    // Get initial greeting
    console.log('[AI] Generating greeting...');
    const greetingStart = Date.now();
    const greeting = await conversationAI.getGreeting();
    const greetingLatency = Date.now() - greetingStart;
    console.log(`[AI] Greeting (${greetingLatency}ms): "${greeting}"\n`);

    // Synthesize and optionally play greeting
    if (config.playAudio) {
      console.log('[TTS] Speaking greeting...');
      const greetingAudio = await synthesizeSpeech(greeting, config.elevenLabsApiKey, config.elevenLabsVoiceId);
      playMulawAudio(greetingAudio.audio);
    }

    // Process each turn
    for (let i = 0; i < script.turns.length; i++) {
      const turn = script.turns[i];
      const turnStart = Date.now();

      console.log(`\n--- Turn ${i + 1}/${script.turns.length} ---`);
      console.log(`[Human] "${turn.human}"`);

      // Generate human speech
      console.log('[Audio] Generating human speech...');
      const humanAudio = await generateSpeechAudio(turn.human);
      console.log(`[Audio] Human speech: ${humanAudio.durationMs.toFixed(0)}ms`);

      // Optionally play human audio
      if (config.playAudio) {
        // Convert PCM to WAV and play
        const tempPcm = join(tmpdir(), `eval_human_${Date.now()}.pcm`);
        const tempWav = join(tmpdir(), `eval_human_${Date.now()}.wav`);
        writeFileSync(tempPcm, humanAudio.pcm);
        execSync(`ffmpeg -y -f s16le -ar 8000 -ac 1 -i "${tempPcm}" "${tempWav}" 2>/dev/null`);
        execSync(`afplay "${tempWav}"`);
        try { unlinkSync(tempPcm); } catch {}
        try { unlinkSync(tempWav); } catch {}
      }

      // Transcribe with Deepgram
      console.log('[STT] Transcribing...');
      const sttResult = await transcribeAudio(humanAudio.pcm, config.deepgramApiKey);
      console.log(`[STT] (${sttResult.latencyMs}ms, conf: ${sttResult.confidence.toFixed(2)}): "${sttResult.transcript}"`);

      // Handle empty transcripts (e.g., "..." for hold)
      if (!sttResult.transcript && turn.human === '...') {
        console.log('[STT] Empty transcript (simulated hold/silence)');
        // Wait and continue
        if (turn.pauseMs) {
          await new Promise(r => setTimeout(r, turn.pauseMs));
        }
        continue;
      }

      // Get AI response
      console.log('[AI] Generating response...');
      const aiResult = await getAIResponse(conversationAI, sttResult.transcript || turn.human);
      console.log(`[AI] (${aiResult.latencyMs}ms): "${aiResult.response}"`);

      // Check if conversation is complete
      if (conversationAI.complete) {
        console.log('[AI] Conversation marked complete');
        result.summary.conversationComplete = true;
      }

      // Synthesize TTS
      console.log('[TTS] Synthesizing...');
      const ttsResult = await synthesizeSpeech(
        aiResult.response,
        config.elevenLabsApiKey,
        config.elevenLabsVoiceId,
      );
      console.log(`[TTS] (${ttsResult.latencyMs}ms, first byte: ${ttsResult.firstByteMs}ms, audio: ${ttsResult.durationMs.toFixed(0)}ms)`);

      // Optionally play TTS audio
      if (config.playAudio) {
        console.log('[TTS] Playing...');
        playMulawAudio(ttsResult.audio);
      }

      // Record metrics
      const totalLatency = Date.now() - turnStart;
      const turnMetrics: TurnMetrics = {
        turnIndex: i,
        humanText: turn.human,
        humanAudioDurationMs: humanAudio.durationMs,
        sttLatencyMs: sttResult.latencyMs,
        sttTranscript: sttResult.transcript,
        sttConfidence: sttResult.confidence,
        aiLatencyMs: aiResult.latencyMs,
        aiResponse: aiResult.response,
        ttsLatencyMs: ttsResult.latencyMs,
        ttsFirstByteMs: ttsResult.firstByteMs,
        ttsAudioDurationMs: ttsResult.durationMs,
        totalTurnLatencyMs: totalLatency,
      };
      result.turns.push(turnMetrics);
      result.summary.completedTurns++;

      // Optional pause between turns
      if (turn.pauseMs && config.playAudio) {
        await new Promise(r => setTimeout(r, turn.pauseMs));
      }

      // Stop if conversation is complete
      if (conversationAI.complete) {
        break;
      }
    }

    // Calculate summary stats
    if (result.turns.length > 0) {
      result.summary.avgSttLatencyMs = result.turns.reduce((sum, t) => sum + t.sttLatencyMs, 0) / result.turns.length;
      result.summary.avgAiLatencyMs = result.turns.reduce((sum, t) => sum + t.aiLatencyMs, 0) / result.turns.length;
      result.summary.avgTtsLatencyMs = result.turns.reduce((sum, t) => sum + t.ttsLatencyMs, 0) / result.turns.length;
      result.summary.avgTotalLatencyMs = result.turns.reduce((sum, t) => sum + t.totalTurnLatencyMs, 0) / result.turns.length;
    }

    result.success = true;

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`\n[ERROR] ${result.error}`);
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  console.log(`Turns completed: ${result.summary.completedTurns}/${result.summary.totalTurns}`);
  console.log(`Avg STT latency: ${result.summary.avgSttLatencyMs.toFixed(0)}ms`);
  console.log(`Avg AI latency: ${result.summary.avgAiLatencyMs.toFixed(0)}ms`);
  console.log(`Avg TTS latency: ${result.summary.avgTtsLatencyMs.toFixed(0)}ms`);
  console.log(`Avg total latency: ${result.summary.avgTotalLatencyMs.toFixed(0)}ms`);
  console.log(`${'='.repeat(60)}\n`);

  // Save results if output dir specified
  if (config.outputDir) {
    if (!existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
    }
    const resultFile = join(config.outputDir, `${script.id}_${Date.now()}.json`);
    writeFileSync(resultFile, JSON.stringify(result, null, 2));
    console.log(`Results saved to: ${resultFile}`);
  }

  return result;
}

/**
 * Run evaluation on multiple scripts
 */
export async function runEvalSuite(
  scripts: ConversationScript[],
  config: EvalConfig,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  console.log(`\n${'#'.repeat(60)}`);
  console.log(`EVAL SUITE: ${scripts.length} scripts`);
  console.log(`${'#'.repeat(60)}\n`);

  for (const script of scripts) {
    const result = await runEval(script, config);
    results.push(result);
  }

  // Print suite summary
  const successful = results.filter(r => r.success).length;
  const avgLatency = results.reduce((sum, r) => sum + r.summary.avgTotalLatencyMs, 0) / results.length;

  console.log(`\n${'#'.repeat(60)}`);
  console.log(`SUITE SUMMARY`);
  console.log(`${'#'.repeat(60)}`);
  console.log(`Scripts: ${successful}/${scripts.length} successful`);
  console.log(`Avg latency across all scripts: ${avgLatency.toFixed(0)}ms`);
  console.log(`${'#'.repeat(60)}\n`);

  return results;
}
