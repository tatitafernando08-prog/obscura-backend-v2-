export const STT_LANGUAGE_CODES: Record<string, string> = {
  english: 'en-US',
  tamil: 'ta-IN',
};

export const TTS_LANGUAGE_CODES: Record<string, string> = {
  english: 'en-US',
  tamil: 'ta-IN',
};

export const VOICE_UNSUPPORTED_MEDIUM_MESSAGE: Record<'english' | 'tamil', string> = {
  english: "Sorry, voice isn't available in Sinhala yet — please use the app for Sinhala questions.",
  tamil: 'மன்னிக்கவும், சிங்களத்தில் குரல் இன்னும் கிடைக்கவில்லை — சிங்கள கேள்விகளுக்கு ஆப்ஸைப் பயன்படுத்தவும்.',
};

export function isVoiceSupportedMedium(medium: string): medium is 'english' | 'tamil' {
  return medium === 'english' || medium === 'tamil';
}
