// Incremental sentence splitter for streaming narrator/agent text into TTS-sized
// chunks. Splits after a `.`, `!`, or `?` that is followed by whitespace or by the
// end of the buffered text so far. v0.1 does NOT protect abbreviations (e.g. "e.g.")
// — narrator copy is written to avoid them, so a false split there is acceptable.
export class SentenceSplitter {
  private buffer = "";

  // Feed one more chunk of text; returns any sentences newly completed by it, in
  // order. Text after the last completed sentence stays buffered for the next
  // push()/flush() call.
  push(chunk: string): string[] {
    this.buffer += chunk;
    const sentences: string[] = [];
    const boundary = /([.!?])(\s+|$)/g;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const end = match.index + match[1].length; // include the punctuation, exclude trailing whitespace
      const sentence = this.buffer.slice(consumed, end).trim();
      if (sentence) sentences.push(sentence);
      consumed = match.index + match[0].length; // also consume the trailing whitespace, if any
    }
    this.buffer = this.buffer.slice(consumed);
    return sentences;
  }

  // Return whatever text is left buffered (trimmed), or null if there is none.
  // Call this once the source of text is done (e.g. end of an agent turn).
  flush(): string | null {
    const tail = this.buffer.trim();
    this.buffer = "";
    return tail.length > 0 ? tail : null;
  }
}
