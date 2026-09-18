// Inbox extractive thread summaries (Superhuman-style). Rule-based, no
// external LLM calls: summarizeThread() scores sentences by term frequency
// (stopwords excluded), position, length, question and action cues, then
// returns the top N in original order. digest() builds a per-thread one-liner
// digest with extracted questions and action items. Pure, frozen outputs.
class SummaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SummaryError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new SummaryError(code, message);
};
const check = (condition, code, message) => {
  if (!condition) fail(code, message);
};

export const DEFAULT_MAX_SENTENCES = 3;
export const MAX_MESSAGES_PER_THREAD = 200;

const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,me,him,her,us,them,my,your,his,our,their,do,does,did,will,would,can,could,should,shall,may,might,must,have,has,had,not,no,yes,so,such,just,than,too,very,also,only,there,here,when,where,what,which,who,whom,how,why,all,any,each,few,more,most,other,some,into,over,after,before,between,through,during,up,down,out,off,again,once,am,pm,re,fw,fwd".split(",")
);
const ACTION_CUES = /\b(please|could you|can you|would you|need to|needs to|action required|todo|to-do|follow up|follow-up|deadline|asap|urgent|let me know|confirm|approve|review)\b/i;
const QUESTION_MARK = /\?\s*$/;

const splitSentences = text =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(\[])/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0 && sentence.length <= 2000);

const tokenize = text =>
  text.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(word => word && !STOPWORDS.has(word));

const checkMessages = messages => {
  check(Array.isArray(messages) && messages.length > 0 && messages.length <= MAX_MESSAGES_PER_THREAD,
    "SUMMARY_INVALID_INPUT", `messages must be a list of 1..${MAX_MESSAGES_PER_THREAD}`);
  for (const message of messages) {
    check(message !== null && typeof message === "object", "SUMMARY_INVALID_INPUT", "messages must be objects");
    check(typeof message.body === "string" && message.body.length > 0, "SUMMARY_INVALID_INPUT", "message body must be a non-empty string");
  }
  return messages;
};

/**
 * Extractive summary of one thread. Returns the top maxSentences sentences in
 * original order plus extracted questions and action items.
 */
export function summarizeThread(messages, { maxSentences = DEFAULT_MAX_SENTENCES } = {}) {
  const checked = checkMessages(messages);
  check(Number.isSafeInteger(maxSentences) && maxSentences >= 1 && maxSentences <= 20,
    "SUMMARY_INVALID_INPUT", "maxSentences must be 1..20");

  // Flatten thread into sentences, tracking message position for weighting.
  const sentences = [];
  checked.forEach((message, messageIndex) => {
    const recencyWeight = 0.6 + (0.4 * (messageIndex + 1)) / checked.length;
    for (const text of splitSentences(message.body)) {
      sentences.push({
        text,
        messageIndex,
        recencyWeight,
        isQuestion: QUESTION_MARK.test(text),
        isAction: ACTION_CUES.test(text),
        length: text.length,
      });
    }
  });
  check(sentences.length > 0, "SUMMARY_INVALID_INPUT", "no sentences found in thread bodies");

  // Term frequencies over the whole thread (stopwords excluded).
  const frequencies = new Map();
  for (const sentence of sentences) {
    for (const word of tokenize(sentence.text)) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }

  const scored = sentences.map((sentence, index) => {
    const words = tokenize(sentence.text);
    const tf = words.reduce((sum, word) => sum + (frequencies.get(word) ?? 0), 0);
    const tfNorm = words.length > 0 ? tf / words.length : 0;
    const position = index === 0 ? 1.25 : index < 3 ? 1.1 : 1.0; // lead bias
    const lengthPenalty = sentence.length < 20 || sentence.length > 400 ? 0.7 : 1.0;
    const questionBoost = sentence.isQuestion ? 1.3 : 1.0;
    const actionBoost = sentence.isAction ? 1.4 : 1.0;
    return {
      index,
      text: sentence.text,
      score: tfNorm * sentence.recencyWeight * position * lengthPenalty * questionBoost * actionBoost,
      isQuestion: sentence.isQuestion,
      isAction: sentence.isAction,
      messageIndex: sentence.messageIndex,
    };
  });

  const top = [...scored]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.min(maxSentences, scored.length))
    .sort((a, b) => a.index - b.index);

  const questions = Object.freeze(
    [...new Set(sentences.filter(sentence => sentence.isQuestion).map(sentence => sentence.text))]
  );
  const actionItems = Object.freeze(
    [...new Set(sentences.filter(sentence => sentence.isAction).map(sentence => sentence.text))]
  );

  return Object.freeze({
    messageCount: checked.length,
    sentenceCount: sentences.length,
    summary: Object.freeze(top.map(entry => entry.text)),
    questions,
    actionItems,
  });
}

/** One-line extractive blurb for a single thread (first top sentence). */
export function threadBlurb(messages) {
  const summary = summarizeThread(messages, { maxSentences: 1 });
  return summary.summary[0] ?? "";
}

/**
 * Digest builder: per-thread blurbs plus aggregate counts, most-asked
 * questions and most-flagged action items across threads. Pure.
 */
export function buildDigest(threads, { blurbSentences = 1 } = {}) {
  check(Array.isArray(threads) && threads.length <= 1000, "SUMMARY_INVALID_INPUT", "threads must be a list of at most 1000");
  const entries = threads.map(thread => {
    check(thread !== null && typeof thread === "object", "SUMMARY_INVALID_INPUT", "thread entries must be objects");
    check(typeof thread.id === "string" && thread.id.length > 0, "SUMMARY_INVALID_INPUT", "thread entry needs an id");
    const summary = summarizeThread(thread.messages, { maxSentences: blurbSentences });
    return Object.freeze({
      threadId: thread.id,
      subject: typeof thread.subject === "string" ? thread.subject : "",
      blurb: summary.summary[0] ?? "",
      messageCount: summary.messageCount,
      questionCount: summary.questions.length,
      actionItemCount: summary.actionItems.length,
      questions: summary.questions,
      actionItems: summary.actionItems,
    });
  });

  const rank = lists => {
    const counts = new Map();
    for (const list of lists) for (const text of list) counts.set(text, (counts.get(text) ?? 0) + 1);
    return Object.freeze([...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10)
      .map(([text, count]) => Object.freeze({ text, count })));
  };

  return Object.freeze({
    threadCount: entries.length,
    totalMessages: entries.reduce((sum, entry) => sum + entry.messageCount, 0),
    totalQuestions: entries.reduce((sum, entry) => sum + entry.questionCount, 0),
    totalActionItems: entries.reduce((sum, entry) => sum + entry.actionItemCount, 0),
    threads: Object.freeze(entries),
    topQuestions: rank(entries.map(entry => entry.questions)),
    topActionItems: rank(entries.map(entry => entry.actionItems)),
  });
}

export { SummaryError };
