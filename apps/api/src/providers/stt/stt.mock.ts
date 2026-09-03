import { Injectable } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { MockBehavior, SeededRandom } from '../mock-support';
import {
  ProviderError,
  type SttProvider,
  type TranscribeInput,
  type TranscribeResult,
  type TranscriptTurn,
} from '../provider.types';

interface ScriptLine {
  speaker: 'agent' | 'customer';
  text: string;
}

/**
 * Scripted logistics conversations, in the register these calls actually happen in
 * — mixed Hindi and English, short customer turns, one clear outcome each.
 *
 * They exist so the summarizer has something real to work on. Lorem ipsum would
 * make the transcript UI look right while telling you nothing about whether the
 * §5.1 summary and next-action extraction produce anything useful, and nothing at
 * all about whether escalation triggers on the calls that should escalate.
 */
const SCRIPTS: Record<string, ScriptLine[][]> = {
  delivery_confirmation: [
    [
      { speaker: 'agent', text: 'Namaste, main Infinity Fleet se bol raha hoon. Aapka consignment INF-4821 kal deliver hone wala hai. Kya aap available rahenge?' },
      { speaker: 'customer', text: 'Haan, main rahunga. Lekin thoda late aana, subah 11 baje ke baad.' },
      { speaker: 'agent', text: 'Bilkul, main 11 baje ke baad ka slot note kar leta hoon. Delivery address wahi hai — Plot 42, Sector 18, Gurugram?' },
      { speaker: 'customer', text: 'Address same hai. Gate pe security ko bol dena, my name is on the list.' },
      { speaker: 'agent', text: 'Note kar liya. Driver aapko pahunchne se pehle call karega. Thank you for your time.' },
      { speaker: 'customer', text: 'Theek hai, thank you.' },
    ],
    [
      { speaker: 'agent', text: 'Good afternoon, this is Infinity Fleet calling about shipment INF-5190 scheduled for tomorrow.' },
      { speaker: 'customer', text: 'Tomorrow will not work. Our warehouse is closed for stock audit until Thursday.' },
      { speaker: 'agent', text: 'Understood. Shall I reschedule the delivery to Thursday morning?' },
      { speaker: 'customer', text: 'Thursday after 2 PM is better. And please send the e-way bill copy on WhatsApp.' },
      { speaker: 'agent', text: 'I have noted Thursday after 2 PM, and I will have the e-way bill sent across on WhatsApp today.' },
      { speaker: 'customer', text: 'Perfect, thanks.' },
    ],
  ],
  payment_reminder: [
    [
      { speaker: 'agent', text: 'Hello, calling from Infinity Fleet accounts. Invoice INV-2291 for forty-two thousand rupees is thirty days overdue.' },
      { speaker: 'customer', text: 'Yes, I know. Our client payment is stuck. Give me one week.' },
      { speaker: 'agent', text: 'I can record a commitment for next week. May I note a specific date?' },
      { speaker: 'customer', text: 'Put down the fifteenth. And stop calling every second day, it is not helping.' },
      { speaker: 'agent', text: 'I will note the fifteenth and reduce the follow-ups. Apologies for the frequency.' },
    ],
    [
      { speaker: 'agent', text: 'Namaste, Infinity Fleet accounts se. Invoice INV-2410 ka payment pending hai — rupees eighteen thousand.' },
      { speaker: 'customer', text: 'Payment ho gaya hai, do din pehle NEFT kiya tha. Aapke system mein reflect nahi hua?' },
      { speaker: 'agent', text: 'Abhi tak reflect nahi hua hai. Kya aap UTR number share kar sakte hain?' },
      { speaker: 'customer', text: 'Main WhatsApp pe bhej dunga. Lekin agar dubara call aaya to main escalate karunga.' },
      { speaker: 'agent', text: 'Samajh gaya. Main isko accounts team ko turant forward kar deta hoon.' },
    ],
  ],
  feedback: [
    [
      { speaker: 'agent', text: 'Hi, Infinity Fleet here, following up on last week delivery. How was the experience?' },
      { speaker: 'customer', text: 'The delivery was fine but two cartons were damaged. Nobody responded to my email.' },
      { speaker: 'agent', text: 'I am sorry about that. Two damaged cartons and an unanswered email — I am logging both.' },
      { speaker: 'customer', text: 'This is the third time. I want someone senior to call me back today.' },
      { speaker: 'agent', text: 'I am escalating this to our service manager now. You will get a call back today.' },
    ],
    [
      { speaker: 'agent', text: 'Good morning, Infinity Fleet calling for quick feedback on consignment INF-4703.' },
      { speaker: 'customer', text: 'All good. Driver was on time, packaging was proper. No complaints.' },
      { speaker: 'agent', text: 'Glad to hear it. Anything we could do better next time?' },
      { speaker: 'customer', text: 'Maybe send the tracking link a bit earlier. Otherwise all good.' },
      { speaker: 'agent', text: 'Noted, we will send tracking earlier. Thank you for your time.' },
    ],
  ],
  default: [
    [
      { speaker: 'agent', text: 'Hello, this is an automated call from Infinity Fleet regarding your account.' },
      { speaker: 'customer', text: 'Okay, go ahead.' },
      { speaker: 'agent', text: 'Our records show an open item that needs your confirmation. Shall I have someone call you?' },
      { speaker: 'customer', text: 'Yes, please have someone call me tomorrow.' },
      { speaker: 'agent', text: 'I will arrange that. Thank you.' },
    ],
  ],
};

/**
 * Deterministic transcription.
 *
 * Seeded from the audio URL rather than from process state, so the same call always
 * transcribes to the same conversation — across reruns, across processes, and in CI.
 * That is what makes an assertion on a call summary stable enough to be worth
 * writing.
 */
@Injectable()
export class SttMockProvider implements SttProvider {
  readonly name = 'stt';
  readonly mode = ProviderMode.MOCK;

  constructor(private readonly behavior: MockBehavior) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    await this.behavior.begin('stt', 'transcribe');

    if (!input.audioUrl && !input.audioBuffer) {
      throw new ProviderError('stt', 'transcribe', 'no_audio', 'Neither audioUrl nor audioBuffer was supplied', false);
    }

    const seed = input.audioUrl ?? `buffer:${input.audioBuffer?.length ?? 0}`;
    const random = new SeededRandom(seed);

    const purpose = (input.context?.purpose ?? 'default').toLowerCase();
    const variants = SCRIPTS[purpose] ?? SCRIPTS.default;
    const script = random.pick(variants);

    // Personalize where the script allows it, so the summary reflects the contact
    // rather than a placeholder name.
    const contactName = input.context?.contactName;

    // ~7 seconds per turn, with jitter, so timings look like a conversation instead
    // of a metronome.
    let cursor = 0;
    const turns: TranscriptTurn[] = script.map((line, index) => {
      const durationMs = 3_500 + random.int(6_500);
      const startMs = cursor;
      cursor += durationMs + 300 + random.int(900);
      return {
        sequence: index + 1,
        speaker: line.speaker,
        text: index === 0 && contactName ? line.text.replace(/^(Namaste|Hello|Hi|Good morning|Good afternoon)/, `$1 ${contactName}`) : line.text,
        startMs,
        endMs: startMs + durationMs,
        // 0.82–0.98: high but not perfect, so any confidence-threshold logic is
        // actually met with values that could fall below it.
        confidence: Number((0.82 + random.next() * 0.16).toFixed(3)),
      };
    });

    const averageConfidence = turns.reduce((total, turn) => total + turn.confidence, 0) / turns.length;

    return {
      turns,
      durationSeconds: Math.ceil(cursor / 1000),
      language: 'multi',
      averageConfidence: Number(averageConfidence.toFixed(3)),
    };
  }
}
