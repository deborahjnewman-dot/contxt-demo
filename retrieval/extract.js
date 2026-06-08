const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const { ok, err } = require('./result');

const BLOCK_TAG_PATTERN = /<(p|div|article|section|br|li|h[1-6])\b[^>]*>/gi;
const SCRIPT_STYLE_PATTERN = /<(script|style|noscript|svg|header|footer|nav|aside)\b[\s\S]*?<\/\1>/gi;
const MIN_EXTRACTED_WORDS = 200;        // under this = likely paywalled/teaser, skip
const MAX_EXTRACTED_PARAGRAPHS = 3;     // spec: first 3 paragraphs only
const MAX_PARAGRAPH_CHARS = 4000;
const MAX_EXTRACTED_CHARS = 12000;

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanText(text) {
  return decodeEntities(text)
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(match[1]) : 'Untitled source';
}


function extractWithReadability(html) {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document, { charThreshold: 200 }).parse();
    if (!article || !article.content) return null;

    const { document: contentDoc } = parseHTML(article.content);
    const paragraphs = [...contentDoc.querySelectorAll('p')]
      .map((p) => cleanText(p.textContent || ''))
      .filter(isUsefulParagraph);

    return { title: article.title ? cleanText(article.title) : '', paragraphs };
  } catch (error) {
    return null;
  }
}

// Fallback extractor: regex paragraph scraping, used when Readability can't parse.
function extractParagraphsFallback(html) {
  const withoutNoise = html.replace(SCRIPT_STYLE_PATTERN, ' ');
  const paragraphMatches = [...withoutNoise.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => cleanText(match[1].replace(/<[^>]+>/g, '')))
    .filter(isUsefulParagraph);

  if (paragraphMatches.length > 0) return paragraphMatches;

  return withoutNoise
    .replace(BLOCK_TAG_PATTERN, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split(/\n+/)
    .map(cleanText)
    .filter(isUsefulParagraph);
}

function isUsefulParagraph(paragraph) {
  if (contentSize(paragraph) < 20) return false; // script-aware (CJK has no spaces)
  if (paragraph.length > MAX_PARAGRAPH_CHARS) return false;
  if (/^copyright \d{4}/i.test(paragraph)) return false;
  if (/^\([^)]*photo\/[^)]*\)$/i.test(paragraph)) return false;
  if (/^\w+ photo\//i.test(paragraph)) return false;
  return true;
}

// First N unique paragraphs (spec: first 3).
function takeFirstParagraphs(paragraphs) {
  const selected = [];
  const seen = new Set();
  for (const paragraph of paragraphs) {
    const key = paragraph.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(paragraph);
    if (selected.length >= MAX_EXTRACTED_PARAGRAPHS) break;
  }
  return selected;
}

function extractArticle(html) {
  if (isLikelyBinary(html)) {
    return err({ code: 'binary_content' });
  }

  const viaReadability = extractWithReadability(html);
  const allParagraphs = viaReadability && viaReadability.paragraphs.length
    ? viaReadability.paragraphs
    : extractParagraphsFallback(html);

  // Paywall/teaser detection looks at the FULL clean body length. Deliberately
  // trimming to 3 paragraphs must not itself trip the 200-word floor, so this
  // check runs before trimming.
  const fullWordCount = contentSize(allParagraphs.join(' '));
  if (fullWordCount < MIN_EXTRACTED_WORDS) {
    return err({ code: 'insufficient_text', wordCount: fullWordCount });
  }

  const paragraphs = takeFirstParagraphs(allParagraphs);
  const extractedText = paragraphs.join('\n\n');
  if (extractedText.length > MAX_EXTRACTED_CHARS) {
    return err({ code: 'extracted_text_too_large', chars: extractedText.length });
  }

  const title = (viaReadability && viaReadability.title) || extractTitle(html);
  return ok({
    title,
    extractedText,
    quotes: extractQuotes(extractedText),
    language: isLikelyEnglish(extractedText) ? 'en' : 'auto'
  });
}

// Script-aware content size. CJK scripts have no spaces, so count those characters
// individually; count everything else as whitespace-delimited words. Prevents
// Chinese/Japanese/Korean articles from being wrongly flagged as paywalled.
const CJK_PATTERN = /[぀-ヿ一-鿿가-힯]/g;
function contentSize(text) {
  const cjk = (text.match(CJK_PATTERN) || []).length;
  const rest = (text.replace(CJK_PATTERN, ' ').match(/\S+/g) || []).length;
  return cjk + rest;
}

function isLikelyBinary(text) {
  const sample = String(text || '').slice(0, 4096);
  if (sample.startsWith('%PDF-')) return true;

  const replacementChars = (sample.match(/\uFFFD/g) || []).length;
  const controlChars = (sample.match(/[\x00-\x08\x0E-\x1F\x7F]/g) || []).length;
  return sample.length > 0 && (replacementChars + controlChars) / sample.length > 0.05;
}

function extractQuotes(text) {
  return [...text.matchAll(/["“]([^"”]{20,280})["”]/g)]
    .slice(0, 3)
    .map((match) => ({
      text: cleanText(match[1]),
      speaker: '',
      context: ''
    }));
}

// Decides only "is this English?" — DeepL auto-detects the actual source language
// when we translate, so a binary call here is all that's needed. Returns false for
// non-Latin scripts (Cyrillic/Arabic/CJK/etc.) and for Latin text with a low
// English-stopword density (Spanish, French, German, Portuguese, ...).
const NON_LATIN_PATTERN = /[Ѐ-ӿ؀-ۿ֐-׿一-鿿぀-ヿ가-힯Ͱ-Ͽ฀-๿]/g;
const ENGLISH_STOPWORDS = [
  'the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'it', 'with', 'as', 'was',
  'on', 'are', 'a', 'an', 'by', 'at', 'from', 'this', 'has', 'have', 'be', 'not'
];

function isLikelyEnglish(text) {
  const nonLatin = (text.match(NON_LATIN_PATTERN) || []).length;
  if (nonLatin > text.length * 0.05) return false;

  const tokens = text.toLowerCase().match(/[a-z']+/g) || [];
  if (tokens.length === 0) return false;

  const stop = new Set(ENGLISH_STOPWORDS);
  const hits = tokens.reduce((count, token) => count + (stop.has(token) ? 1 : 0), 0);
  return hits / tokens.length > 0.08;
}

module.exports = { extractArticle, isLikelyEnglish, contentSize, isLikelyBinary };
