/*********************************************************************
 * Copyright (c) 2026 NVIDIA Corporation and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

export const formatLogPointEvaluationError = (error: unknown): string =>
    `<error: ${error instanceof Error ? error.message : String(error)}>`;

type LogPointSegment = { literal: string } | { expression: string };

/**
 * Split a log point message into literal text and `{expression}` placeholders.
 *
 * Placeholders are delimited by balanced curly braces, so an expression may
 * itself contain nested braces (e.g. `{sizeof((int[]){1,2,3})}`). An unbalanced
 * or empty `{...}` is emitted verbatim as literal text rather than evaluated.
 */
const parseLogPointMessage = (message: string): LogPointSegment[] => {
    const segments: LogPointSegment[] = [];
    let literal = '';
    const flushLiteral = () => {
        if (literal) {
            segments.push({ literal });
            literal = '';
        }
    };

    for (let i = 0; i < message.length; i++) {
        if (message[i] !== '{') {
            literal += message[i];
            continue;
        }

        // Find the closing brace that matches this opening brace, tracking
        // nesting so inner braces don't terminate the placeholder early.
        let depth = 1;
        let j = i + 1;
        for (; j < message.length && depth > 0; j++) {
            if (message[j] === '{') {
                depth++;
            } else if (message[j] === '}') {
                depth--;
            }
        }

        const expression = message.slice(i + 1, j - 1);
        if (depth !== 0 || expression.trim() === '') {
            // Unbalanced or empty: leave the text as-is.
            literal += message[i];
            continue;
        }

        flushLiteral();
        segments.push({ expression });
        i = j - 1;
    }

    flushLiteral();
    return segments;
};

export async function resolveLogPointMessage(
    message: string,
    evaluate: (expression: string) => Promise<string>,
): Promise<string> {
    const segments = parseLogPointMessage(message);
    const resolved = await Promise.all(
        segments.map(async (segment) => {
            if ('literal' in segment) {
                return segment.literal;
            }
            try {
                return await evaluate(segment.expression.trim());
            } catch (error) {
                return formatLogPointEvaluationError(error);
            }
        }),
    );
    return resolved.join('');
}
