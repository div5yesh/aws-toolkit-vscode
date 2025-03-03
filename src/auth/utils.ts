/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../shared/extensionGlobals'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import * as localizedText from '../shared/localizedText'
import { codicon, getIcon } from '../shared/icons'
import { createQuickPick, DataQuickPickItem, showQuickPick } from '../shared/ui/pickerPrompter'
import { isValidResponse } from '../shared/wizards/wizard'
import { CancellationError } from '../shared/utilities/timeoutUtils'
import { formatError, ToolkitError } from '../shared/errors'
import { asString } from './providers/credentials'
import { getResourceFromTreeNode } from '../shared/treeview/utils'
import { Instance } from '../shared/utilities/typeConstructors'
import { TreeNode } from '../shared/treeview/resourceTreeDataProvider'
import { createInputBox } from '../shared/ui/inputPrompter'
import { telemetry } from '../shared/telemetry/telemetry'
import { createCommonButtons, createExitButton, createHelpButton, createRefreshButton } from '../shared/ui/buttons'
import { getIdeProperties, isCloud9 } from '../shared/extensionUtilities'
import { authHelpUrl } from '../shared/constants'
import { getDependentAuths } from './secondaryAuth'
import { DevSettings } from '../shared/settings'
import { createRegionPrompter } from '../shared/ui/common/region'
import { saveProfileToCredentials } from './credentials/sharedCredentials'
import { SectionName, StaticProfile } from './credentials/types'
import { throwOnInvalidCredentials } from './credentials/validation'
import {
    Connection,
    SsoConnection,
    createBuilderIdProfile,
    createSsoProfile,
    defaultSsoRegion,
    isAnySsoConnection,
    isIdcSsoConnection,
    isBuilderIdConnection,
    isIamConnection,
    isValidCodeCatalystConnection,
} from './connection'
import { Commands, placeholder, vscodeComponent } from '../shared/vscode/commands2'
import { Auth } from './auth'
import { validateIsNewSsoUrl, validateSsoUrlFormat } from './sso/validation'
import { openUrl } from '../shared/utilities/vsCodeUtils'
import { AuthSource } from './ui/vue/show'
import { getLogger } from '../shared/logger'
import { isValidCodeWhispererCoreConnection } from '../codewhisperer/util/authUtil'

// TODO: Look to do some refactoring to handle circular dependency later and move this to ./commands.ts
export const showConnectionsPageCommand = 'aws.auth.manageConnections'

export async function promptForConnection(auth: Auth, type?: 'iam' | 'sso'): Promise<Connection | void> {
    const resp = await createConnectionPrompter(auth, type).prompt()
    if (!isValidResponse(resp)) {
        throw new CancellationError('user')
    }

    if (resp === 'addNewConnection') {
        // TODO: Cannot call function directly due to circular dependency. Refactor to fix this.
        const source: AuthSource = 'addConnectionQuickPick' // enforcing type sanity check
        vscode.commands.executeCommand(showConnectionsPageCommand, placeholder, source)
        return undefined
    }

    if (resp === 'editCredentials') {
        return globals.awsContextCommands.onCommandEditCredentials()
    }

    return resp
}

export async function promptAndUseConnection(...[auth, type]: Parameters<typeof promptForConnection>) {
    return telemetry.aws_setCredentials.run(async span => {
        const resp = await promptForConnection(auth, type)
        if (!resp) {
            throw new CancellationError('user')
        }

        await auth.useConnection(resp)
    })
}

const switchConnections = Commands.register('aws.auth.switchConnections', (auth: Auth | TreeNode | unknown) => {
    telemetry.ui_click.emit({ elementId: 'devtools_connectToAws' })

    if (!(auth instanceof Auth)) {
        try {
            auth = getResourceFromTreeNode(auth, Instance(Auth))
        } catch {
            // Fall back in case this command is called from something in package.json.
            // If so, then the value of auth will be unusable.
            auth = Auth.instance
        }
    }

    return promptAndUseConnection(auth as Auth)
})

export async function signout(auth: Auth, conn: Connection | undefined = auth.activeConnection) {
    if (conn?.type === 'sso') {
        // TODO: does deleting the connection make sense UX-wise?
        // this makes it disappear from the list of available connections
        await auth.deleteConnection(conn)

        const iamConnections = (await auth.listConnections()).filter(c => c.type === 'iam')
        const fallbackConn = iamConnections.find(c => c.id === 'profile:default') ?? iamConnections[0]
        if (fallbackConn !== undefined) {
            await auth.useConnection(fallbackConn)
        }
    } else {
        await auth.logout()

        const fallbackConn = (await auth.listConnections()).find(c => c.type === 'sso')
        if (fallbackConn !== undefined) {
            await auth.useConnection(fallbackConn)
        }
    }
}

export const createBuilderIdItem = () =>
    ({
        label: codicon`${getIcon('vscode-person')} ${localize(
            'aws.auth.builderIdItem.label',
            'Use a personal email to sign up and sign in with {0}',
            localizedText.builderId()
        )}`,
        data: 'builderId',
        onClick: () => telemetry.ui_click.emit({ elementId: 'connection_optionBuilderID' }),
        detail: `${localizedText.builderId()} is a new, personal profile for builders.`, // TODO: need a "Learn more" button ?
    } as DataQuickPickItem<'builderId'>)

export const createSsoItem = () =>
    ({
        label: codicon`${getIcon('vscode-organization')} ${localize(
            'aws.auth.ssoItem.label',
            'Connect using {0} {1}',
            getIdeProperties().company,
            localizedText.iamIdentityCenter
        )}`,
        data: 'sso',
        onClick: () => telemetry.ui_click.emit({ elementId: 'connection_optionSSO' }),
        detail: `Sign in to your company's ${localizedText.iamIdentityCenter} access portal login page.`,
    } as DataQuickPickItem<'sso'>)

export const createIamItem = () =>
    ({
        label: codicon`${getIcon('vscode-key')} ${localize('aws.auth.iamItem.label', 'Use IAM Credentials')}`,
        data: 'iam',
        onClick: () => telemetry.ui_click.emit({ elementId: 'connection_optionIAM' }),
        detail: 'Activates working with resources in the Explorer. Not supported by CodeWhisperer. Requires an access key ID and secret access key.',
    } as DataQuickPickItem<'iam'>)

export async function createStartUrlPrompter(title: string, requiredScopes?: string[]) {
    const existingConnections = (await Auth.instance.listConnections()).filter(isAnySsoConnection)

    function validateSsoUrl(url: string) {
        const urlFormatError = validateSsoUrlFormat(url)
        if (urlFormatError) {
            return urlFormatError
        }

        return validateIsNewSsoUrl(url, requiredScopes, existingConnections)
    }

    return createInputBox({
        title: `${title}: Enter Start URL`,
        placeholder: `Enter start URL for your organization's IAM Identity Center`,
        buttons: [createHelpButton(), createExitButton()],
        validateInput: validateSsoUrl,
    })
}

export async function createBuilderIdConnection(auth: Auth, scopes?: string[]) {
    const newProfile = createBuilderIdProfile(scopes)
    const existingConn = (await auth.listConnections()).find(isBuilderIdConnection)
    if (!existingConn) {
        return auth.createConnection(newProfile)
    }

    const userResponse = await promptLogoutExistingBuilderIdConnection()
    if (userResponse !== 'signout') {
        throw new CancellationError('user')
    }

    await signout(auth, existingConn)

    return auth.createConnection(newProfile)
}

/**
 * Prompts the user to log out of an existing Builder ID connection.
 *
 * @returns The name of the action performed by the user
 */
async function promptLogoutExistingBuilderIdConnection(): Promise<'signout' | 'cancel'> {
    const items: DataQuickPickItem<'signout' | 'cancel'>[] = [
        {
            data: 'signout',
            label: `Currently signed in with ${getIdeProperties().company} Builder ID. Sign out to add another?`,
            detail: `This will sign out of your current ${
                getIdeProperties().company
            } Builder ID and open the sign-in page in browser.`,
        },
        { data: 'cancel', label: 'Cancel' },
    ]
    const resp = await showQuickPick(items, {
        title: `Sign in to different ${getIdeProperties().company} Builder ID`,
        buttons: createCommonButtons() as vscode.QuickInputButton[],
    })

    return resp === undefined ? 'cancel' : resp
}

export async function showRegionPrompter(
    title: string = `IAM Identity Center: Select Region`,
    placeholder: string = `Select region for your organization's IAM Identity Center`
) {
    const region = await createRegionPrompter(undefined, {
        defaultRegion: defaultSsoRegion,
        buttons: createCommonButtons(),
        title: title,
        placeholder: placeholder,
    }).prompt()

    if (!isValidResponse(region)) {
        throw new CancellationError('user')
    }
    telemetry.ui_click.emit({ elementId: 'connection_region' })

    return region
}

Commands.register('aws.auth.help', async () => {
    openUrl(vscode.Uri.parse(authHelpUrl))
    telemetry.aws_help.emit()
})

Commands.register('aws.auth.signout', () => {
    telemetry.ui_click.emit({ elementId: 'devtools_signout' })
    return signout(Auth.instance)
})

export const addConnection = Commands.register(
    { id: 'aws.auth.addConnection', telemetryThrottleMs: false },
    async () => {
        const c9IamItem = createIamItem()
        c9IamItem.detail =
            'Activates working with resources in the Explorer. Requires an access key ID and secret access key.'
        const items = isCloud9()
            ? [createSsoItem(), c9IamItem]
            : [createBuilderIdItem(), createSsoItem(), createIamItem()]

        const resp = await showQuickPick(items, {
            title: localize('aws.auth.addConnection.title', 'Add a Connection to {0}', getIdeProperties().company),
            placeholder: localize('aws.auth.addConnection.placeholder', 'Select a connection option'),
            buttons: createCommonButtons() as vscode.QuickInputButton[],
        })
        if (!isValidResponse(resp)) {
            telemetry.ui_click.emit({ elementId: 'connection_optionescapecancel' })
            throw new CancellationError('user')
        }

        switch (resp) {
            case 'iam':
                return await globals.awsContextCommands.onCommandCreateCredentialsProfile()
            case 'sso': {
                const startUrlPrompter = await createStartUrlPrompter('IAM Identity Center')
                const startUrl = await startUrlPrompter.prompt()
                if (!isValidResponse(startUrl)) {
                    throw new CancellationError('user')
                }
                telemetry.ui_click.emit({ elementId: 'connection_startUrl' })

                const region = await showRegionPrompter()

                const conn = await Auth.instance.createConnection(createSsoProfile(startUrl, region.id))
                return Auth.instance.useConnection(conn)
            }
            case 'builderId': {
                return createBuilderIdConnection(Auth.instance)
            }
        }
    }
)

export async function tryAddCredentials(
    profileName: SectionName,
    profileData: StaticProfile,
    tryConnect = true
): Promise<boolean> {
    const auth = Auth.instance

    // sanity checks
    await throwOnInvalidCredentials(profileName, profileData)
    const authenticationError = await auth.authenticateData(profileData)
    if (authenticationError) {
        throw new ToolkitError(`Found error with '${authenticationError.key}':'${authenticationError.error}' `, {
            code: 'InvalidCredentials',
        })
    }

    await saveProfileToCredentials(profileName, profileData)

    if (tryConnect) {
        const id = asString({
            credentialSource: 'profile',
            credentialTypeId: profileName,
        })
        const conn = await auth.getConnection({ id })

        if (conn === undefined) {
            throw new ToolkitError(`Failed to get connection from profile: ${profileName}`, {
                code: 'MissingConnection',
            })
        }

        await auth.useConnection(conn)
    }
    return true
}

const getConnectionIcon = (conn: Connection) =>
    conn.type === 'sso' ? getIcon('vscode-account') : getIcon('vscode-key')

const deleteConnection = 'Delete Connection'
export const createDeleteConnectionButton: () => vscode.QuickInputButton = () => {
    return { tooltip: deleteConnection, iconPath: getIcon('vscode-trash') }
}

export function createConnectionPrompter(auth: Auth, type?: 'iam' | 'sso') {
    const addNewConnection = {
        label: codicon`${getIcon('vscode-plus')} Add New Connection`,
        data: 'addNewConnection' as const,
    }
    const editCredentials = {
        label: codicon`${getIcon('vscode-pencil')} Edit Credentials`,
        data: 'editCredentials' as const,
    }
    const placeholder =
        type === 'iam'
            ? localize('aws.auth.promptConnection.iam.placeholder', 'Select an IAM credential')
            : localize('aws.auth.promptConnection.all.placeholder', 'Select a connection')

    const refreshPrompter = () => {
        // This function should not return a promise, or else tests fail.

        prompter.clearAndLoadItems(loadItems()).catch(e => {
            getLogger().error(`Auth: Failed loading connections in quickpick: %s`, e)
            throw e
        })
    }
    const refreshButton = createRefreshButton()
    refreshButton.onClick = refreshPrompter

    // Place add/edit connection items at the bottom, then sort 'sso' connections
    // first, then valid connections, then finally the item label
    function getSortOrder(item: DataQuickPickItem<Connection | string>) {
        if (item.data === addNewConnection.data) {
            return 10
        } else if (item.data === editCredentials.data) {
            return 9
        }

        const conn = item.data as Connection
        if (conn.type === 'sso') {
            return 0
        } else if (auth.getConnectionState(conn) === 'valid') {
            return 1
        }

        return 2
    }

    const prompter = createQuickPick(loadItems(), {
        placeholder,
        title: localize('aws.auth.promptConnection.title', 'Switch Connection'),
        buttons: [refreshButton, createExitButton()],
        compare: (a, b) => {
            if (getSortOrder(a) === 0 && getSortOrder(b) === 0) {
                return a.label.localeCompare(b.label)
            }

            return getSortOrder(a) - getSortOrder(b)
        },
    })

    prompter.quickPick.onDidTriggerItemButton(async e => {
        // User wants to delete a specific connection
        if (e.button.tooltip === deleteConnection) {
            const conn = e.item.data as Connection

            // Set prompter in to a busy state so that
            // tests must wait for refresh to fully complete
            prompter.busy = true
            await auth.deleteConnection(conn)
            refreshPrompter()
        }
    })

    return prompter

    async function* loadItems(): AsyncGenerator<
        DataQuickPickItem<Connection | 'addNewConnection' | 'editCredentials'>[]
    > {
        const connections = auth.listAndTraverseConnections()

        let hasShownEdit = false

        yield [addNewConnection]
        for await (const conn of connections) {
            if (conn.label.includes('profile:') && !hasShownEdit) {
                hasShownEdit = true
                yield [toPickerItem(conn), editCredentials]
            } else {
                yield [toPickerItem(conn)]
            }
        }
    }

    function toPickerItem(conn: Connection): DataQuickPickItem<Connection> {
        const state = auth.getConnectionState(conn)
        // Only allow SSO connections to be deleted
        const deleteButton: vscode.QuickInputButton[] = conn.type === 'sso' ? [createDeleteConnectionButton()] : []
        if (state === 'valid') {
            return {
                data: conn,
                label: codicon`${getConnectionIcon(conn)} ${conn.label}`,
                description: getConnectionDescription(conn),
                buttons: [...deleteButton],
            }
        }

        const getDetail = () => {
            if (!DevSettings.instance.get('renderDebugDetails', false)) {
                return
            }

            const err = auth.getInvalidationReason(conn)
            return err ? formatError(err) : undefined
        }

        return {
            detail: getDetail(),
            data: conn,
            invalidSelection: state !== 'authenticating',
            label: codicon`${getIcon('vscode-error')} ${conn.label}`,
            buttons: [...deleteButton],
            description:
                state === 'authenticating'
                    ? 'authenticating...'
                    : localize(
                          'aws.auth.promptConnection.expired.description',
                          'Expired or Invalid, select to authenticate'
                      ),
            onClick:
                state !== 'authenticating'
                    ? async () => {
                          // XXX: this is hack because only 1 picker can be shown at a time
                          // Some legacy auth providers will show a picker, hiding this one
                          // If we detect this then we'll jump straight into using the connection
                          let hidden = false
                          const sub = prompter.quickPick.onDidHide(() => {
                              hidden = true
                              sub.dispose()
                          })
                          const newConn = await reauthCommand.execute(auth, conn)
                          if (hidden && newConn && auth.getConnectionState(newConn) === 'valid') {
                              await auth.useConnection(newConn)
                          } else {
                              await prompter.clearAndLoadItems(loadItems())
                              prompter.selectItems(
                                  ...prompter.quickPick.items.filter(i => i.label.includes(conn.label))
                              )
                          }
                      }
                    : undefined,
        }
    }

    function getConnectionDescription(conn: Connection) {
        if (conn.type === 'iam') {
            // TODO: implement a proper `getConnectionSource` method to discover where a connection came from
            const descSuffix = conn.id.startsWith('profile:')
                ? 'configured locally (~/.aws/config)'
                : conn.id.startsWith('sso:')
                ? 'sourced from IAM Identity Center'
                : 'sourced from the environment'

            return `IAM Credential, ${descSuffix}`
        }

        const toolAuths = getDependentAuths(conn)
        if (toolAuths.length === 0) {
            return undefined
        } else if (toolAuths.length === 1) {
            return `Connected to ${toolAuths[0].toolLabel}`
        } else {
            return `Connected to Dev Tools`
        }
    }
}

export const reauthCommand = Commands.register('_aws.auth.reauthenticate', async (auth: Auth, conn: Connection) => {
    try {
        return await auth.reauthenticate(conn)
    } catch (err) {
        throw ToolkitError.chain(err, 'Unable to authenticate connection')
    }
})

// Used to decouple from the `Commands` implementation
Commands.register('_aws.auth.autoConnect', () => Auth.instance.tryAutoConnect())

export const useIamCredentials = Commands.register('_aws.auth.useIamCredentials', (auth: Auth) => {
    telemetry.ui_click.emit({ elementId: 'explorer_IAMselect_VSCode' })

    return promptAndUseConnection(auth, 'iam')
})

// Legacy commands
export const login = Commands.register('aws.login', async () => {
    const auth = Auth.instance
    const connections = await auth.listConnections()
    if (connections.length === 0) {
        const source: AuthSource = vscodeComponent
        return vscode.commands.executeCommand(showConnectionsPageCommand, placeholder, source)
    } else {
        return switchConnections.execute(auth)
    }
})
Commands.register('aws.logout', () => signout(Auth.instance))
Commands.register('aws.credentials.edit', () => globals.awsContextCommands.onCommandEditCredentials())
Commands.register('aws.credentials.profile.create', async () => {
    try {
        await globals.awsContextCommands.onCommandCreateCredentialsProfile()
    } finally {
        telemetry.aws_createCredentials.emit()
    }
})

function mapEventType<T, U = void>(event: vscode.Event<T>, fn?: (val: T) => U): vscode.Event<U> {
    const emitter = new vscode.EventEmitter<U>()
    event(val => (fn ? emitter.fire(fn(val)) : emitter.fire(undefined as U)))

    return emitter.event
}

export class AuthNode implements TreeNode<Auth> {
    public readonly id = 'auth'
    public readonly onDidChangeTreeItem = mapEventType(this.resource.onDidChangeActiveConnection)

    public constructor(public readonly resource: Auth) {}

    public getTreeItem() {
        // Calling this here is robust but `TreeShim` must be instantiated lazily to stop side-effects
        this.resource.tryAutoConnect()

        if (!this.resource.hasConnections) {
            const item = new vscode.TreeItem(`Connect to ${getIdeProperties().company} to Get Started...`)
            const source: AuthSource = 'authNode'
            item.command = {
                title: 'Add Connection',
                command: showConnectionsPageCommand,
                arguments: [placeholder, source],
            }

            return item
        }

        const conn = this.resource.activeConnection
        const itemLabel =
            conn?.label !== undefined
                ? localize('aws.auth.node.connected', `Connected with {0}`, conn.label)
                : localize('aws.auth.node.selectConnection', 'Select a connection...')

        const item = new vscode.TreeItem(itemLabel)
        item.contextValue = 'awsAuthNode'

        if (conn !== undefined && conn.state !== 'valid') {
            item.iconPath = getIcon('vscode-error')
            if (conn.state === 'authenticating') {
                this.setDescription(item, 'authenticating...')
            } else {
                this.setDescription(item, 'expired or invalid, click to authenticate')
                item.command = reauthCommand.build(this.resource, conn).asCommand({ title: 'Reauthenticate' })
            }
        } else {
            item.command = switchConnections.build(this.resource).asCommand({ title: 'Login' })
            item.iconPath = conn !== undefined ? getConnectionIcon(conn) : undefined
        }

        return item
    }

    private setDescription(item: vscode.TreeItem, text: string) {
        if (isCloud9()) {
            item.tooltip = item.tooltip ?? text
        } else {
            item.description = text
        }
    }
}

export async function hasIamCredentials(
    allConnections = () => Auth.instance.listAndTraverseConnections().promise()
): Promise<boolean> {
    return (await allConnections()).some(isIamConnection)
}

export type SsoKind = 'any' | 'codewhisperer' | 'codecatalyst'

/**
 * Returns true if an Identity Center SSO connection exists.
 *
 * @param kind A specific kind of Identity Center SSO connection that must exist.
 * @param allConnections func to get all connections that exist
 */
export async function hasSso(
    kind: SsoKind = 'any',
    allConnections = () => Auth.instance.listConnections()
): Promise<boolean> {
    return (await findSsoConnections(kind, allConnections)).length > 0
}

export async function findSsoConnections(
    kind: SsoKind = 'any',
    allConnections = () => Auth.instance.listConnections()
): Promise<SsoConnection[]> {
    let predicate: (c?: Connection) => boolean
    switch (kind) {
        case 'codewhisperer':
            predicate = (conn?: Connection) => {
                return isIdcSsoConnection(conn) && isValidCodeWhispererCoreConnection(conn)
            }
            break
        case 'codecatalyst':
            predicate = (conn?: Connection) => {
                return isIdcSsoConnection(conn) && isValidCodeCatalystConnection(conn)
            }
            break
        case 'any':
            predicate = isIdcSsoConnection
    }
    return (await allConnections()).filter(predicate).filter(isIdcSsoConnection)
}

export type BuilderIdKind = 'any' | 'codewhisperer' | 'codecatalyst'

/**
 * Returns true if a Builder ID connection exists.
 *
 * @param kind A Builder ID connection that has the scopes of this kind.
 * @param allConnections func to get all connections that exist
 */
export async function hasBuilderId(
    kind: BuilderIdKind = 'any',
    allConnections = () => Auth.instance.listConnections()
): Promise<boolean> {
    return (await findBuilderIdConnections(kind, allConnections)).length > 0
}

async function findBuilderIdConnections(
    kind: BuilderIdKind = 'any',
    allConnections = () => Auth.instance.listConnections()
): Promise<SsoConnection[]> {
    let predicate: (c?: Connection) => boolean
    switch (kind) {
        case 'codewhisperer':
            predicate = (conn?: Connection) => {
                return isBuilderIdConnection(conn) && isValidCodeWhispererCoreConnection(conn)
            }
            break
        case 'codecatalyst':
            predicate = (conn?: Connection) => {
                return isBuilderIdConnection(conn) && isValidCodeCatalystConnection(conn)
            }
            break
        case 'any':
            predicate = isBuilderIdConnection
    }
    return (await allConnections()).filter(predicate).filter(isAnySsoConnection)
}

/**
 * Class to get info about the user + use of this extension
 *
 * Why is this extension in this file?
 * - Due to circular dependency issues since this class needs to use the {@link Auth}
 *   instance. If we can find a better spot and not run in to the isssue this should be moved.
 *
 * Keywords for searchability:
 * - new user
 * - first time
 */
export class ExtensionUse {
    public readonly isExtensionFirstUseKey = 'isExtensionFirstUse'

    // The result of if is first use for the remainder of the extension session.
    // This will reset on next startup.
    private isFirstUseCurrentSession: boolean | undefined

    isFirstUse(
        state: vscode.Memento = globals.context.globalState,
        hasExistingConnections = () => Auth.instance.hasConnections
    ): boolean {
        if (this.isFirstUseCurrentSession !== undefined) {
            return this.isFirstUseCurrentSession
        }

        this.isFirstUseCurrentSession = state.get(this.isExtensionFirstUseKey)
        if (this.isFirstUseCurrentSession === undefined) {
            // The variable in the store is not defined yet, fallback to checking if they have existing connections.
            this.isFirstUseCurrentSession = !hasExistingConnections()

            getLogger().debug(
                `isFirstUse: State not found, marking user as '${
                    this.isFirstUseCurrentSession ? '' : 'NOT '
                }first use' since they 'did ${this.isFirstUseCurrentSession ? 'NOT ' : ''}have existing connections'.`
            )
        }

        // Update state, so next time it is not first use
        state.update(this.isExtensionFirstUseKey, false)

        return this.isFirstUseCurrentSession
    }

    static #instance: ExtensionUse

    static get instance(): ExtensionUse {
        return (this.#instance ??= new ExtensionUse())
    }
}
