import { describe, expect, it } from 'vitest';
import { resolveUploadPolicy, type UploadPolicy } from '../upload-policies';
import { evaluateContent, sniffAndCheck } from '../content-sniffer';

// Inline policy fixtures — the removed Connect categories used to provide
// audio / video / mixed-media policies. The sniffer is category-agnostic (it
// only reads `mimeTypes` off the policy shape), so literals of the same shape
// keep every behavioral assertion intact.
const MB = 1024 * 1024;
const AUDIO_POLICY: UploadPolicy = {
  maxBytes: 10 * MB,
  mimeTypes: ['audio/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav'],
};
const VIDEO_POLICY: UploadPolicy = {
  maxBytes: 50 * MB,
  mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
};
// Image + video, like a feed-post category — exercises cross-family checks.
const MIXED_MEDIA_POLICY: UploadPolicy = {
  maxBytes: 50 * MB,
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'],
};

/**
 * Magic-byte content sniffing tests. Buffers below are real, minimal fixtures
 * verified against `file-type@16.5.4`'s detector (1x1 images, an ISO-BMFF
 * `ftyp` box, an EBML/WebM header, a real OOXML zip, an MZ executable header).
 * They exercise the full sniff path end to end (file-type + decision logic),
 * plus a few pure-logic cases via `evaluateContent`.
 */

const b64 = (s: string) => Buffer.from(s, 'base64');
const hex = (s: string) => Buffer.from(s, 'hex');

// ── Verified fixtures ─────────────────────────────────────────────────────
const JPEG = b64(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
);
const PNG = b64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQH/9Q0BAAAAAElFTkSuQmCC',
);
const WEBP = b64('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=');
const MP4 = b64('AAAAGGZ0eXBpc29tAAAAAWlzb21tcDQy');
// Minimal EBML/WebM header — file-type reports `video/webm` for this.
const WEBM = hex('1a45dfa3874282847765626d');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF', 'utf8');
// Real OOXML (docx) zip: [Content_Types].xml + _rels/.rels + word/document.xml.
const DOCX = b64(
  'UEsDBBQAAAAAAAAAAADGEnoH8QAAAPEAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCI/PjxUeXBlcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9jb250ZW50LXR5cGVzIj48T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+PC9UeXBlcz5QSwMEFAAAAAAAAAAAACuEJhIEAAAABAAAAAsAAABfcmVscy8ucmVsczx4Lz5QSwMEFAAAAAAAAAAAAFfbPvNDAAAAQwAAABEAAAB3b3JkL2RvY3VtZW50LnhtbDw/eG1sIHZlcnNpb249IjEuMCI/Pjx3OmRvY3VtZW50IHhtbG5zOnc9IngiPjx3OmJvZHkvPjwvdzpkb2N1bWVudD5QSwECFAAUAAAAAAAAAAAAxhJ6B/EAAADxAAAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAAAAAAAAArhCYSBAAAAAQAAAALAAAAAAAAAAAAAAAAACIBAABfcmVscy8ucmVsc1BLAQIUABQAAAAAAAAAAABX2z7zQwAAAEMAAAARAAAAAAAAAAAAAAAAAE8BAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAADBAQAAAAA=',
);
// MZ executable header — file-type reports `application/x-msdownload`.
const EXE = hex('4d5a90000300000004000000ffff0000b800');
// SVG with an XML prolog — file-type reports `application/xml` (not an image).
const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'utf8',
);
// Plain text — file-type cannot classify it (returns undefined).
const TEXT = Buffer.from('just some plain text, not a binary file at all\n'.repeat(8), 'utf8');
// Legacy OLE2/CFB container (D0 CF 11 E0 A1 B1 1A E1) shared by all pre-2007
// Office formats — file-type reports `application/x-cfb`.
const CFB = Buffer.concat([hex('d0cf11e0a1b11ae1'), Buffer.alloc(24)]);

describe('sniffAndCheck — valid media accepted under the right category', () => {
  it('accepts a real JPEG under avatars', async () => {
    expect(await sniffAndCheck(JPEG, 'image/jpeg', resolveUploadPolicy('avatars'))).toBeNull();
  });

  it('accepts a real PNG under avatars', async () => {
    expect(await sniffAndCheck(PNG, 'image/png', resolveUploadPolicy('avatars'))).toBeNull();
  });

  it('accepts a real WebP under profiles', async () => {
    expect(await sniffAndCheck(WEBP, 'image/webp', resolveUploadPolicy('profiles'))).toBeNull();
  });

  it('accepts a real MP4 under a video-capable policy', async () => {
    expect(await sniffAndCheck(MP4, 'video/mp4', VIDEO_POLICY)).toBeNull();
  });

  it('accepts a real PDF under documents', async () => {
    expect(
      await sniffAndCheck(PDF, 'application/pdf', resolveUploadPolicy('documents')),
    ).toBeNull();
  });

  it('accepts a real DOCX under documents (sniffs as OOXML, not bare zip)', async () => {
    const declared = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(await sniffAndCheck(DOCX, declared, resolveUploadPolicy('documents'))).toBeNull();
  });
});

describe('sniffAndCheck — legacy Office (CFB container)', () => {
  it('accepts a legacy .doc (CFB) declared application/msword under documents', async () => {
    // file-type sees `application/x-cfb`; the documents policy allows
    // application/msword, which is equivalent to the shared CFB container.
    const v = await sniffAndCheck(CFB, 'application/msword', resolveUploadPolicy('documents'));
    expect(v).toBeNull();
  });

  it('rejects CFB bytes declared image/jpeg under an image-only category', async () => {
    // The avatars policy allows no legacy Office type, so the CFB container is
    // not permitted there even when the client lies about the mime.
    const v = await sniffAndCheck(CFB, 'image/jpeg', resolveUploadPolicy('avatars'));
    expect(v).not.toBeNull();
    expect(v?.reason).toBe('content-mismatch');
  });
});

describe('sniffAndCheck — spoofed / mismatched content rejected', () => {
  it('rejects EXE bytes declared as image/jpeg', async () => {
    const v = await sniffAndCheck(EXE, 'image/jpeg', resolveUploadPolicy('avatars'));
    expect(v).not.toBeNull();
    expect(v?.reason).toBe('content-mismatch');
  });

  it('rejects an SVG declared as image/png (svg is in no policy)', async () => {
    const v = await sniffAndCheck(SVG, 'image/png', resolveUploadPolicy('avatars'));
    expect(v).not.toBeNull();
    expect(v?.reason).toBe('content-mismatch');
  });

  it('rejects undetectable (plain text) content under an image-only category', async () => {
    const v = await sniffAndCheck(TEXT, 'image/png', resolveUploadPolicy('qrcodes'));
    expect(v).not.toBeNull();
    expect(v?.reason).toBe('content-undetectable');
  });
});

describe('sniffAndCheck — equivalence groups (must NOT reject)', () => {
  it('accepts a WebM voice note declared audio/webm but sniffed video/webm', async () => {
    // The audio policy allows audio/webm; the bytes sniff as video/webm.
    const v = await sniffAndCheck(WEBM, 'audio/webm', AUDIO_POLICY);
    expect(v).toBeNull();
  });
});

describe('evaluateContent — pure decision logic', () => {
  const imagePolicy = resolveUploadPolicy('avatars'); // image-only, binary

  it('treats image/jpg as image/jpeg (alias equivalence)', () => {
    expect(
      evaluateContent({
        declaredMime: 'image/jpg',
        detectedMime: 'image/jpeg',
        policy: imagePolicy,
      }),
    ).toBeNull();
  });

  it('treats audio/mp4 <-> video/mp4 as equivalent under an audio policy', () => {
    expect(
      evaluateContent({
        declaredMime: 'audio/mp4',
        detectedMime: 'video/mp4',
        policy: AUDIO_POLICY,
      }),
    ).toBeNull();
  });

  it('treats video/quicktime <-> video/mp4 as equivalent under a video policy', () => {
    expect(
      evaluateContent({
        declaredMime: 'video/quicktime',
        detectedMime: 'video/mp4',
        policy: VIDEO_POLICY,
      }),
    ).toBeNull();
  });

  it('rejects a cross-family disagreement even when detected is allowed', () => {
    // The mixed policy allows both images and video; declaring video but
    // shipping an image is a cross-family lie and is rejected.
    const v = evaluateContent({
      declaredMime: 'video/mp4',
      detectedMime: 'image/png',
      policy: MIXED_MEDIA_POLICY,
    });
    expect(v?.reason).toBe('content-mismatch');
  });

  it('rejects undetectable content for a binary-only policy', () => {
    expect(
      evaluateContent({ declaredMime: 'image/png', detectedMime: undefined, policy: imagePolicy })
        ?.reason,
    ).toBe('content-undetectable');
  });

  it('defers (passes) undetectable content when the policy allows a text-like type', () => {
    const textPolicy = { maxBytes: 1024, mimeTypes: ['text/csv', 'text/plain'] as const };
    expect(
      evaluateContent({ declaredMime: 'text/csv', detectedMime: undefined, policy: textPolicy }),
    ).toBeNull();
  });
});
