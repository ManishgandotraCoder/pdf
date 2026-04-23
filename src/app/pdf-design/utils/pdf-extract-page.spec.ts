import { describe, expect, it } from 'vitest';

import type { TextStyle } from '../models/pdf-design.models';
import { createPdfRichTextBlocks } from './pdf-rich-text-blocks';
import type { ExtractedTextRun } from './pdf-extract-page';
import { mergeAdjacentTextRuns } from './pdf-extract-page';

const TITLE_STYLE: TextStyle = {
  fontFamily: 'Helvetica',
  fontSize: 18,
  fontSizePx: 27,
  fontWeight: 'normal',
  fontStyle: 'normal',
  color: '#13808b',
};

const BODY_STYLE: TextStyle = {
  fontFamily: 'Helvetica',
  fontSize: 14,
  fontSizePx: 21,
  fontWeight: 'normal',
  fontStyle: 'normal',
  color: '#4b5563',
};

function makeRun(
  content: string,
  x: number,
  y: number,
  w: number,
  h: number,
  style: TextStyle,
): ExtractedTextRun {
  return {
    x,
    y,
    w,
    h,
    content,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontSizePx: style.fontSizePx || style.fontSize,
    fontWeight: style.fontWeight as 'bold' | 'normal',
    fontStyle: style.fontStyle as 'italic' | 'normal',
    color: style.color,
  };
}

describe('mergeAdjacentTextRuns', () => {
  it('keeps same-style text runs in separate columns from merging together', () => {
    const text = mergeAdjacentTextRuns([
      makeRun('Siddharth Boruah', 460, 160, 270, 34, TITLE_STYLE),
      makeRun('Relevant Projects', 1020, 160, 230, 34, TITLE_STYLE),
      makeRun('Role: Project Coordinator', 460, 205, 285, 24, BODY_STYLE),
      makeRun('1050 Marietta Street, Atlanta, Georgia, USA', 1020, 205, 460, 24, BODY_STYLE),
    ], 7);

    expect(text).toHaveLength(4);
    expect(text.map((item) => item.content)).toEqual([
      'Siddharth Boruah',
      'Relevant Projects',
      'Role: Project Coordinator',
      '1050 Marietta Street, Atlanta, Georgia, USA',
    ]);
  });

  it('still merges nearby runs that belong to the same text line', () => {
    const text = mergeAdjacentTextRuns([
      makeRun('Project', 56, 55, 88, 38, TITLE_STYLE),
      makeRun('Team', 154, 55, 88, 38, TITLE_STYLE),
    ], 7);

    expect(text).toHaveLength(1);
    expect(text[0]?.content).toBe('Project Team');
  });
});

describe('createPdfRichTextBlocks', () => {
  it('keeps the project-team page split into local text blocks instead of one giant overlay', () => {
    const textElements = mergeAdjacentTextRuns([
      makeRun('Siddharth Boruah', 460, 160, 270, 34, TITLE_STYLE),
      makeRun('Relevant Projects', 1020, 160, 230, 34, TITLE_STYLE),
      makeRun('Role: Project Coordinator', 460, 205, 285, 24, BODY_STYLE),
      makeRun('1050 Marietta Street, Atlanta, Georgia, USA', 1020, 205, 460, 24, BODY_STYLE),
      makeRun('Background', 460, 318, 170, 34, TITLE_STYLE),
      makeRun('Post-Graduate Diploma in Urban Planning and', 460, 350, 510, 24, BODY_STYLE),
      makeRun('1690 Peachtree Street, Atlanta, Georgia, USA', 1020, 350, 470, 24, BODY_STYLE),
      makeRun('Development, IGNOU, Delhi, India', 490, 385, 360, 24, BODY_STYLE),
      makeRun(
        '1690 Peachtree Street is a mixed-use project in Atlanta with retail, residential, office',
        1020,
        385,
        780,
        24,
        BODY_STYLE,
      ),
      makeRun('246 Perimeter Place, Atlanta, Georgia, USA', 1020, 620, 450, 24, BODY_STYLE),
      makeRun('Siddharth likes to approach design in a holistic method.', 56, 690, 790, 28, BODY_STYLE),
    ], 7);

    const blocks = createPdfRichTextBlocks(textElements);

    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(blocks.every((block) => block.w < 1400)).toBe(true);

    const nameBlock = blocks.find((block) => block.html.includes('Siddharth Boruah'));
    expect(nameBlock).toBeTruthy();
    expect(nameBlock?.html).not.toContain('Relevant Projects');
    expect(nameBlock?.html).not.toContain('1050 Marietta Street');
    expect(nameBlock?.x).toBeGreaterThan(400);
    expect(nameBlock?.w).toBeLessThan(700);

    const projectsBlock = blocks.find((block) => block.html.includes('Relevant Projects'));
    expect(projectsBlock).toBeTruthy();
    expect(projectsBlock?.html).not.toContain('Siddharth Boruah');
    expect(projectsBlock?.html).not.toContain('Background');
    expect(projectsBlock?.x).toBeGreaterThan(900);
    expect(projectsBlock?.w).toBeLessThan(900);

    const bottomBlock = blocks.find((block) => block.html.includes('approach design in a holistic method'));
    expect(bottomBlock).toBeTruthy();
    expect(bottomBlock?.y).toBeGreaterThan(650);
    expect(bottomBlock?.x).toBeLessThan(120);
  });
});
