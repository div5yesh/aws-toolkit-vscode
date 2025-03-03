/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as config from './config'
import { ExtContext } from '../shared/extensions'
import { createCommonButtons } from '../shared/ui/buttons'
import { createQuickPick } from '../shared/ui/pickerPrompter'
import { DevSettings } from '../shared/settings'
import { FileProvider, VirtualFileSystem } from '../shared/virtualFilesystem'
import { Commands } from '../shared/vscode/commands2'
import { createInputBox } from '../shared/ui/inputPrompter'
import { Wizard } from '../shared/wizards/wizard'
import { deleteDevEnvCommand, installVsixCommand, openTerminalCommand } from './codecatalyst'
import { watchBetaVSIX } from './beta'
import { isCloud9 } from '../shared/extensionUtilities'
import { entries } from '../shared/utilities/tsUtils'
import { isReleaseVersion } from '../shared/vscode/env'
import { isAnySsoConnection } from '../auth/connection'
import { Auth } from '../auth/auth'

interface MenuOption {
    readonly label: string
    readonly description?: string
    readonly detail?: string
    readonly executor: (ctx: ExtContext) => Promise<unknown> | unknown
}

/**
 * Defines AWS Toolkit developer tools.
 *
 * Options are displayed as quick-pick items. The {@link MenuOption.executor} callback is ran
 * on selection. There is no support for name-spacing. Just add the relevant
 * feature/module as a description so it can be moved around easier.
 */
const menuOptions: Record<string, MenuOption> = {
    installVsix: {
        label: 'Install VSIX on Remote Environment',
        description: 'CodeCatalyst',
        detail: 'Automatically upload/install a VSIX to a remote host',
        executor: installVsixCommand,
    },
    openTerminal: {
        label: 'Open Remote Terminal',
        description: 'CodeCatalyst',
        detail: 'Open a new terminal connected to the remote environment',
        executor: openTerminalCommand,
    },
    deleteDevEnv: {
        label: 'Delete Workspace',
        description: 'CodeCatalyst',
        detail: 'Deletes the selected Dev Environment',
        executor: deleteDevEnvCommand,
    },
    editStorage: {
        label: 'Edit Storage',
        description: 'VS Code',
        detail: 'Edit a key in global/secret storage as a JSON document',
        executor: openStorageFromInput,
    },
    showGlobalState: {
        label: 'Show Global State',
        description: 'AWS Toolkit',
        detail: 'Shows various state (including environment variables)',
        executor: showGlobalState,
    },
    deleteSsoConnections: {
        label: 'Auth: Delete SSO Connections',
        detail: 'Deletes all SSO Connections the extension is using.',
        executor: deleteSsoConnections,
    },
    expireSsoConnections: {
        label: 'Auth: Expire SSO Connections',
        detail: 'Force expires all SSO Connections, in to a "needs reauthentication" state.',
        executor: expireSsoConnections,
    },
}

export class GlobalStateDocumentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        let s = 'Environment variables known to AWS Toolkit:\n'
        for (const [k, v] of Object.entries(process.env)) {
            s += `${k}=${v}\n`
        }
        return s
    }
}

/**
 * Enables internal developer tools.
 *
 * Commands prefixed with `AWS (Developer)` will appear so long as a developer setting is active.
 *
 * See {@link DevSettings} for more information.
 */
export function activate(ctx: ExtContext): void {
    const devSettings = DevSettings.instance

    async function updateMode() {
        await vscode.commands.executeCommand('setContext', 'aws.isDevMode', devSettings.isDevMode())
    }

    ctx.extensionContext.subscriptions.push(
        devSettings.onDidChangeActiveSettings(updateMode),
        vscode.commands.registerCommand('aws.dev.openMenu', () => openMenu(ctx, menuOptions)),
        vscode.workspace.registerTextDocumentContentProvider('aws-dev2', new GlobalStateDocumentProvider())
    )

    updateMode()

    const editor = new ObjectEditor(ctx.extensionContext)
    ctx.extensionContext.subscriptions.push(openStorageCommand.register(editor))

    if (!isCloud9() && !isReleaseVersion() && config.betaUrl) {
        ctx.extensionContext.subscriptions.push(watchBetaVSIX(config.betaUrl))
    }
}

async function openMenu(ctx: ExtContext, options: typeof menuOptions): Promise<void> {
    const items = entries(options).map(([_, v]) => ({
        label: v.label,
        detail: v.detail,
        description: v.description,
        skipEstimate: true,
        data: v.executor.bind(undefined, ctx),
    }))

    const prompter = createQuickPick(items, {
        title: 'Developer Menu',
        buttons: createCommonButtons(),
    })

    await prompter.prompt()
}

function isSecrets(obj: vscode.Memento | vscode.SecretStorage): obj is vscode.SecretStorage {
    return (obj as vscode.SecretStorage).store !== undefined
}

class VirtualObjectFile implements FileProvider {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>()
    public readonly onDidChange = this.onDidChangeEmitter.event

    public constructor(private readonly storage: vscode.Memento | vscode.SecretStorage, private readonly key: string) {}

    public stat(): { ctime: number; mtime: number; size: number } {
        // This would need to be filled out to track conflicts
        return { ctime: 0, mtime: 0, size: 0 }
    }

    public async read(): Promise<Uint8Array> {
        const encoder = new TextEncoder()

        return encoder.encode(await this.readStore(this.key))
    }

    public async write(content: Uint8Array): Promise<void> {
        const decoder = new TextDecoder()
        const value = JSON.parse(decoder.decode(content))

        await this.updateStore(this.key, value)
    }

    private async readStore(key: string): Promise<string> {
        // Could potentially show `undefined` in the editor instead of an empty string
        if (isSecrets(this.storage)) {
            const value = (await this.storage.get(key)) ?? ''
            return JSON.stringify(JSON.parse(value), undefined, 4)
        } else {
            return JSON.stringify(this.storage.get(key, {}), undefined, 4)
        }
    }

    private async updateStore(key: string, value: unknown): Promise<unknown> {
        if (isSecrets(this.storage)) {
            return this.storage.store(key, JSON.stringify(value))
        } else {
            return this.storage.update(key, value)
        }
    }
}

interface Tab {
    readonly editor: vscode.TextEditor
    dispose(): void
}

class ObjectEditor {
    private static readonly scheme = 'aws-dev'

    private readonly fs = new VirtualFileSystem()
    private readonly tabs: Map<string, Tab> = new Map()

    public constructor(private readonly context: vscode.ExtensionContext) {
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = this.fs.uriToKey(doc.uri)
            this.tabs.get(key)?.dispose()
            this.tabs.delete(key)
        })

        vscode.workspace.registerFileSystemProvider(ObjectEditor.scheme, this.fs)
    }

    public async openStorage(type: 'globals' | 'secrets', key: string): Promise<void> {
        switch (type) {
            case 'globals':
                return this.openState(this.context.globalState, key)
            case 'secrets':
                return this.openState(this.context.secrets, key)
        }
    }

    private async openState(storage: vscode.Memento | vscode.SecretStorage, key: string): Promise<void> {
        const uri = this.uriFromKey(key, storage)
        const tab = this.tabs.get(this.fs.uriToKey(uri))

        if (tab) {
            await vscode.window.showTextDocument(tab.editor.document)
        } else {
            const newTab = await this.createTab(storage, key)
            const newKey = this.fs.uriToKey(newTab.editor.document.uri)
            this.tabs.set(newKey, newTab)
        }
    }

    private async createTab(storage: vscode.Memento | vscode.SecretStorage, key: string): Promise<Tab> {
        const uri = this.uriFromKey(key, storage)
        const disposable = this.fs.registerProvider(uri, new VirtualObjectFile(storage, key))
        const document = await vscode.workspace.openTextDocument(uri)
        const withLanguage = await vscode.languages.setTextDocumentLanguage(document, 'json')
        const editor = await vscode.window.showTextDocument(withLanguage)

        return {
            editor,
            dispose: () => disposable.dispose(),
        }
    }

    private uriFromKey(key: string, storage: vscode.Memento | vscode.SecretStorage): vscode.Uri {
        const prefix = isSecrets(storage) ? 'secrets' : 'globals'

        return vscode.Uri.parse(`${ObjectEditor.scheme}:`, true).with({
            path: `/${prefix}/${key}`,
        })
    }
}

async function openStorageFromInput() {
    const wizard = new (class extends Wizard<{ target: 'globals' | 'secrets'; key: string }> {
        constructor() {
            super()

            this.form.target.bindPrompter(() =>
                createQuickPick(
                    [
                        { label: 'Global State', data: 'globals' },
                        { label: 'Secrets', data: 'secrets' },
                    ],
                    {
                        title: 'Select a storage type',
                    }
                )
            )

            this.form.key.bindPrompter(({ target }) =>
                createInputBox({
                    title: 'Enter a key',
                    placeholder: target === 'globals' ? 'region' : '',
                })
            )
        }
    })()

    const response = await wizard.run()

    if (response) {
        return openStorageCommand.execute(response.target, response.key)
    }
}

async function deleteSsoConnections() {
    const conns = Auth.instance.listConnections()
    const ssoConns = (await conns).filter(isAnySsoConnection)
    await Promise.all(ssoConns.map(conn => Auth.instance.deleteConnection(conn)))
    vscode.window.showInformationMessage(`Deleted: ${ssoConns.map(c => c.startUrl).join(', ')}`)
}

async function expireSsoConnections() {
    const conns = Auth.instance.listConnections()
    const ssoConns = (await conns).filter(isAnySsoConnection)
    await Promise.all(ssoConns.map(conn => Auth.instance.expireConnection(conn)))
    vscode.window.showInformationMessage(`Expired: ${ssoConns.map(c => c.startUrl).join(', ')}`)
}

async function showGlobalState() {
    const uri = vscode.Uri.parse('aws-dev2:global-state')
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc, { preview: false })
}

export const openStorageCommand = Commands.from(ObjectEditor).declareOpenStorage('_aws.dev.openStorage')
