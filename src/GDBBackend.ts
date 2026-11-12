/*********************************************************************
 * Copyright (c) 2018 QNX Software Systems and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/
import { spawn, ChildProcess } from 'child_process';
import * as events from 'events';
import { Writable } from 'stream';
import { logger } from '@vscode/debugadapter/lib/logger';
import {
    AttachRequestArguments,
    LaunchRequestArguments,
} from './GDBDebugSession';
import * as mi from './mi';
import { MIResponse } from './mi';
import { MIParser } from './MIParser';
import { VarManager } from './varManager';
import { compareVersions, getGdbVersion } from './util';

export interface MIExecNextRequest {
    reverse?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface MIExecNextResponse extends MIResponse {}

export interface MIGDBShowResponse extends MIResponse {
    value?: string;
}

export declare interface GDBBackend {
    on(
        event: 'consoleStreamOutput',
        listener: (output: string, category: string) => void,
    ): this;
    on(
        event: 'execAsync' | 'notifyAsync' | 'statusAsync',
        listener: (asyncClass: string, data: any) => void,
    ): this;

    emit(
        event: 'consoleStreamOutput',
        output: string,
        category: string,
    ): boolean;
    emit(
        event: 'execAsync' | 'notifyAsync' | 'statusAsync',
        asyncClass: string,
        data: any,
    ): boolean;
}

export class GDBBackend extends events.EventEmitter {
    protected parser = new MIParser(this);
    protected varMgr = new VarManager(this);
    protected out?: Writable;
    protected token = 0;
    protected proc?: ChildProcess;
    private gdbVersion?: string;
    private spawnCommandLine?: { path: string; args: string[] };
    protected gdbAsync = false;
    protected gdbNonStop = false;
    protected hardwareBreakpoint = false;

    // Buffers console warnings of the form:
    //   "warning: Error in testing condition for breakpoint N:"
    //   "<parse error detail on the following console line>"
    // so any GDB session subclass — regardless of how it wires up
    // consoleStreamOutput — can surface a UI-level warning when a
    // breakpoint condition fails to parse and GDB falls back to an
    // unconditional breakpoint. Centralized here (rather than in each
    // session subclass's own listener) because consoleStreamOutput is
    // emitted from multiple sources (stdout via MIParser, stderr
    // directly in spawn()) that different session subclasses wire up
    // independently — see GDBDebugSession.attachOrLaunchRequest vs.
    // GDBTargetDebugSession.setupCommonLoggerAndHandlers.
    private pendingConditionWarnings = new Map<string, string>();
    private awaitingConditionWarningDetail:
        | { bpNum: string; category: string }
        | undefined;

    get varManager(): VarManager {
        return this.varMgr;
    }

    public emit(
        event: 'consoleStreamOutput',
        output: string,
        category: string,
    ): boolean;
    public emit(
        event: 'execAsync' | 'notifyAsync' | 'statusAsync',
        asyncClass: string,
        data: any,
    ): boolean;
    public emit(event: string | symbol, ...args: any[]): boolean {
        if (event === 'consoleStreamOutput') {
            this.processConsoleStreamOutput(
                args[0] as string,
                args[1] as string,
            );
        }
        return super.emit(event, ...args);
    }

    private processConsoleStreamOutput(output: string, category: string): void {
        const condWarningMatch = output.match(
            /^warning: Error in testing condition for breakpoint (\d+):/,
        );
        if (condWarningMatch) {
            const bpNum = condWarningMatch[1];
            this.awaitingConditionWarningDetail = { bpNum, category };
            this.pendingConditionWarnings.set(bpNum, output);
        } else if (this.awaitingConditionWarningDetail) {
            // Only treat this as the continuation line if it arrived on the
            // same stream/category as the warning itself — consoleStreamOutput
            // carries stdout, stderr, and log output interleaved, so a line
            // from a different category landing here is unrelated output
            // that happened to arrive between the two warning lines, not
            // the detail we're waiting for. Keep waiting rather than giving
            // up, so the detail isn't lost if unrelated output from another
            // category interleaves before the real continuation line arrives.
            // A fresh warning header (handled in the branch above) still
            // resets this state regardless of category, so we never wait
            // indefinitely on a stale warning.
            if (category !== this.awaitingConditionWarningDetail.category) {
                return;
            }
            const { bpNum } = this.awaitingConditionWarningDetail;
            const existing = this.pendingConditionWarnings.get(bpNum) ?? '';
            this.pendingConditionWarnings.set(
                bpNum,
                `${existing} ${output}`.trim(),
            );
            this.awaitingConditionWarningDetail = undefined;
        }
    }

    /**
     * Returns and clears the buffered invalid-condition warning for the
     * given breakpoint number, if one is pending. Used by session
     * subclasses to surface a UI-level warning (e.g. a toast) the first
     * time a breakpoint with a condition that failed to parse is hit.
     */
    public consumePendingConditionWarning(bpNum: string): string | undefined {
        const warning = this.pendingConditionWarnings.get(bpNum);
        if (warning !== undefined) {
            this.pendingConditionWarnings.delete(bpNum);
        }
        return warning;
    }

    get commandLine(): { path: string; args: string[] } | undefined {
        return this.spawnCommandLine;
    }

    public async spawn(
        requestArgs: LaunchRequestArguments | AttachRequestArguments,
    ) {
        const gdbPath = requestArgs.gdb || 'gdb';
        this.gdbVersion = await getGdbVersion(gdbPath);
        let args = ['--interpreter=mi2'];
        if (requestArgs.gdbArguments) {
            args = args.concat(requestArgs.gdbArguments);
        }
        this.spawnCommandLine = { path: gdbPath, args };
        this.proc = spawn(gdbPath, args);
        if (this.proc.stdin == null || this.proc.stdout == null) {
            throw new Error('Spawned GDB does not have stdout or stdin');
        }
        this.out = this.proc.stdin;
        this.hardwareBreakpoint = requestArgs.hardwareBreakpoint ? true : false;
        await this.parser.parse(this.proc.stdout);
        if (this.proc.stderr) {
            this.proc.stderr.on('data', (chunk) => {
                const newChunk = chunk.toString();
                this.emit('consoleStreamOutput', newChunk, 'stderr');
            });
        }
        await this.setNonStopMode(requestArgs.gdbNonStop);
        await this.setAsyncMode(requestArgs.gdbAsync);
    }

    public async spawnInClientTerminal(
        requestArgs: LaunchRequestArguments | AttachRequestArguments,
        cb: (args: string[]) => Promise<void>,
    ) {
        const gdbPath = requestArgs.gdb || 'gdb';
        this.gdbVersion = await getGdbVersion(gdbPath);
        // Use dynamic import to remove need for natively building this adapter
        // Useful when 'spawnInClientTerminal' isn't needed, but adapter is distributed on multiple OS's
        const { Pty } = await import('./native/pty');
        const pty = new Pty();
        let args = [gdbPath, '-ex', `new-ui mi2 ${pty.slave_name}`];
        if (requestArgs.gdbArguments) {
            args = args.concat(requestArgs.gdbArguments);
        }
        this.spawnCommandLine = { path: gdbPath, args: args.slice(1) };
        await cb(args);
        this.out = pty.writer;
        await this.parser.parse(pty.reader);
        await this.setNonStopMode(requestArgs.gdbNonStop);
        await this.setAsyncMode(requestArgs.gdbAsync);
    }

    public async setAsyncMode(isSet?: boolean) {
        const command = this.gdbVersionAtLeast('7.8')
            ? 'mi-async'
            : 'target-async';
        if (isSet === undefined) {
            isSet = true;
        }
        if (this.gdbNonStop) {
            isSet = true;
        }
        const onoff = isSet ? 'on' : 'off';
        try {
            await this.sendCommand(`-gdb-set ${command} ${onoff}`);
            this.gdbAsync = isSet;
        } catch {
            // no async support - normally this only happens on Windows
            // when doing host debugging. We explicitly set this
            // to off here so that we get the error propogate if the -gdb-set
            // failed and to make it easier to read the log
            await this.sendCommand(`-gdb-set ${command} off`);
            this.gdbAsync = false;
        }
    }

    public async setNonStopMode(isSet?: boolean) {
        if (isSet === undefined) {
            isSet = false;
        }
        if (isSet) {
            await this.sendCommand('-gdb-set pagination off');
        }
        const onoff = isSet ? 'on' : 'off';
        try {
            await this.sendCommand(`-gdb-set non-stop ${onoff}`);
            this.gdbNonStop = isSet;
        } catch {
            // no non-stop support - normally this only happens on Windows.
            // We explicitly set this to off here so that we get the error
            // propogate if the -gdb-set failed and to make it easier to
            // read the log
            await this.sendCommand(`-gdb-set non-stop off`);
            this.gdbNonStop = false;
        }
    }

    public isNonStopMode() {
        return this.gdbNonStop;
    }

    public isUseHWBreakpoint() {
        return this.hardwareBreakpoint;
    }

    public pause(threadId?: number) {
        if (this.gdbAsync) {
            mi.sendExecInterrupt(this, threadId);
        } else {
            if (!this.proc) {
                throw new Error('GDB is not running, nothing to interrupt');
            }
            logger.verbose(`GDB signal: SIGINT to pid ${this.proc.pid}`);
            this.proc.kill('SIGINT');
        }
    }

    public async supportsNewUi(gdbPath?: string): Promise<boolean> {
        this.gdbVersion = await getGdbVersion(gdbPath || 'gdb');
        return this.gdbVersionAtLeast('7.12');
    }

    public gdbVersionAtLeast(targetVersion: string): boolean {
        if (!this.gdbVersion) {
            throw new Error('gdbVersion needs to be set first');
        }
        return compareVersions(this.gdbVersion, targetVersion) >= 0;
    }

    /**
     * Sends multiple commands sequentially.
     * Each command can be a string or an object { text: string, ignoreFailures: boolean }.
     * If a command is a string, it's treated as { text: command, ignoreFailures: false }.
     * If ignoreFailures is true for a command, errors during its execution are logged but do not stop subsequent commands.
     * If ignoreFailures is false (or implied for a string command), errors will stop execution and be re-thrown.
     */
    public async sendCommands(
        commands?: Array<string | { text: string; ignoreFailures: boolean }>,
    ): Promise<void> {
        if (commands) {
            for (const commandItem of commands) {
                let commandText: string;
                let ignoreFailures: boolean;

                if (typeof commandItem === 'string') {
                    commandText = commandItem;
                    ignoreFailures = false;
                } else {
                    commandText = commandItem.text;
                    ignoreFailures = commandItem.ignoreFailures;
                }

                try {
                    await this.sendCommand(commandText);
                } catch (error) {
                    if (ignoreFailures) {
                        // Log the error but continue the loop
                        const errorMessage =
                            error instanceof Error
                                ? error.message
                                : String(error);
                        logger.warn(
                            `Setup command "${commandText}" failed but failures are ignored: ${errorMessage}`,
                        );
                    } else {
                        // Re-throw the error to stop execution for commands where failures are NOT ignored
                        throw error;
                    }
                }
            }
        }
    }

    public sendCommand<T>(command: string): Promise<T> {
        const token = this.nextToken();
        logger.verbose(`GDB command: ${token} ${command}`);
        return new Promise<T>((resolve, reject) => {
            if (this.out) {
                this.parser.queueCommand(token, (resultClass, resultData) => {
                    switch (resultClass) {
                        case 'done':
                        case 'running':
                        case 'connected':
                        case 'exit':
                            resolve(resultData);
                            break;
                        case 'error':
                            reject(new Error(resultData.msg));
                            break;
                        default:
                            reject(
                                new Error(
                                    `Unknown response ${resultClass}: ${JSON.stringify(
                                        resultData,
                                    )}`,
                                ),
                            );
                    }
                });
                this.out.write(`${token}${command}\n`);
            } else {
                reject(new Error('gdb is not running.'));
            }
        });
    }

    public sendEnablePrettyPrint() {
        return this.sendCommand('-enable-pretty-printing');
    }

    // Rewrite the argument escaping whitespace, quotes and backslash
    public standardEscape(arg: string, needQuotes = true): string {
        let result = '';
        for (const char of arg) {
            if (char === '\\' || char === '"') {
                result += '\\';
            }
            if (char == ' ') {
                needQuotes = true;
            }
            result += char;
        }
        if (needQuotes) {
            result = `"${result}"`;
        }
        return result;
    }

    public sendFileExecAndSymbols(program: string) {
        return this.sendCommand(
            `-file-exec-and-symbols ${this.standardEscape(program)}`,
        );
    }

    public sendFileSymbolFile(symbols: string) {
        return this.sendCommand(
            `-file-symbol-file ${this.standardEscape(symbols)}`,
        );
    }

    public sendAddSymbolFile(symbols: string, offset: string) {
        return this.sendCommand(
            `add-symbol-file ${this.standardEscape(symbols)} ${offset}`,
        );
    }

    public sendLoad(imageFileName: string, imageOffset: string | undefined) {
        return this.sendCommand(
            `load ${this.standardEscape(imageFileName)} ${imageOffset || ''}`,
        );
    }

    public sendGDBSet(params: string) {
        return this.sendCommand(`-gdb-set ${params}`);
    }

    public sendGDBShow(params: string): Promise<MIGDBShowResponse> {
        return this.sendCommand(`-gdb-show ${params}`);
    }

    public sendGDBExit() {
        return this.sendCommand('-gdb-exit');
    }

    protected nextToken() {
        return this.token++;
    }
}
