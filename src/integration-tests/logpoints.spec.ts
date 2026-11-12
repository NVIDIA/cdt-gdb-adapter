/*********************************************************************
 * Copyright (c) 2019 Arm and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import { join } from 'path';
import { expect } from 'chai';
import {
    formatLogPointEvaluationError,
    resolveLogPointMessage,
} from '../logpoint';
import { CdtDebugClient } from './debugClient';
import { fillDefaults, standardBeforeEach, testProgramsDir } from './utils';

describe('logpoint message resolution', () => {
    it('returns the message unchanged when there are no placeholders', async () => {
        const result = await resolveLogPointMessage(
            'plain log line',
            async () => {
                throw new Error('should not evaluate');
            },
        );

        expect(result).to.eq('plain log line');
    });

    it('interpolates evaluated expressions', async () => {
        const evaluate = async (expression: string) => {
            const values: Record<string, string> = {
                'blockIdx.x': '0',
                'threadIdx.y': '3',
                'wA * BLOCK_SIZE * blockIdx.y': '10240',
            };
            return values[expression] ?? '';
        };

        const result = await resolveLogPointMessage(
            'block(bx={blockIdx.x}) thread(ty={threadIdx.y}) aBegin={wA * BLOCK_SIZE * blockIdx.y}',
            evaluate,
        );

        expect(result).to.eq('block(bx=0) thread(ty=3) aBegin=10240');
    });

    it('substitutes evaluation errors for typos without failing the log line', async () => {
        const evaluate = async (expression: string) => {
            if (expression === 'count') {
                return '7';
            }
            throw new Error('No symbol "cout" in current context.');
        };

        const result = await resolveLogPointMessage(
            'count={count} typo={cout}',
            evaluate,
        );

        expect(result).to.eq(
            'count=7 typo=<error: No symbol "cout" in current context.>',
        );
    });

    it('evaluates expressions containing nested braces', async () => {
        const evaluate = async (expression: string) => {
            expect(expression).to.eq('sizeof((int[]){1,2,3})');
            return '12';
        };

        const result = await resolveLogPointMessage(
            'size={sizeof((int[]){1,2,3})}',
            evaluate,
        );

        expect(result).to.eq('size=12');
    });

    it('leaves unbalanced braces as literal text', async () => {
        const result = await resolveLogPointMessage(
            'open brace { then {count}',
            async (expression) => {
                expect(expression).to.eq('count');
                return '5';
            },
        );

        expect(result).to.eq('open brace { then 5');
    });

    it('leaves empty braces as literal text', async () => {
        const result = await resolveLogPointMessage('empty {}', async () => {
            throw new Error('should not evaluate');
        });

        expect(result).to.eq('empty {}');
    });

    it('formats evaluation errors consistently', () => {
        expect(formatLogPointEvaluationError(new Error('bad expr'))).to.eq(
            '<error: bad expr>',
        );
        expect(formatLogPointEvaluationError('oops')).to.eq('<error: oops>');
    });
});

describe('logpoints', async () => {
    let dc: CdtDebugClient;

    beforeEach(async function () {
        dc = await standardBeforeEach();

        await dc.launchRequest(
            fillDefaults(this.currentTest, {
                program: join(testProgramsDir, 'count'),
            }),
        );
    });

    afterEach(async () => {
        await dc.stop();
    });

    it('hits a logpoint', async () => {
        const logMessage = 'log message';

        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    logMessage,
                },
            ],
        });
        await dc.configurationDoneRequest();
        const logEvent = await dc.waitForOutputEvent('console');
        expect(logEvent.body.output).to.eq(logMessage);
    });

    it('supports changing log messages', async () => {
        const logMessage = 'log message';

        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    logMessage: 'something uninteresting',
                },
            ],
        });
        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    logMessage,
                },
            ],
        });
        await dc.configurationDoneRequest();
        const logEvent = await dc.waitForOutputEvent('console');
        expect(logEvent.body.output).to.eq(logMessage);
    });

    it('interpolates expressions in log messages', async () => {
        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    logMessage: 'count={count} another={another}',
                },
            ],
        });
        await dc.configurationDoneRequest();
        const logEvent = await dc.waitForOutputEvent('console');
        expect(logEvent.body.output).to.match(/^count=\d+ another=\d+$/);
    });

    it('substitutes evaluation errors for invalid expressions', async () => {
        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    logMessage: 'count={count} typo={cout}',
                },
            ],
        });
        await dc.configurationDoneRequest();
        const logEvent = await dc.waitForOutputEvent('console');
        expect(logEvent.body.output).to.match(/^count=\d+ typo=<error: .+>$/);
    });

    it('evaluates expressions containing quotes', async () => {
        // Regression test: the expression is quoted for MI, so embedded quotes
        // must be escaped or the evaluation breaks. `sizeof("hello")` is 6 in C.
        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    logMessage: 'len={sizeof("hello")}',
                },
            ],
        });
        await dc.configurationDoneRequest();
        const logEvent = await dc.waitForOutputEvent('console');
        expect(logEvent.body.output).to.eq('len=6');
    });
});
