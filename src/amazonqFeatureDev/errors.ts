/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolkitError } from '../shared/errors'
import { featureName } from './constants'

export class ConversationIdNotFoundError extends ToolkitError {
    constructor() {
        super('Conversation id must exist before continuing', { code: 'ConversationIdNotFound' })
    }
}

export class TabIdNotFoundError extends ToolkitError {
    constructor(query: string) {
        super(`Tab id was not found from ${query}`, { code: 'TabIdNotFound' })
    }
}

export class PanelLoadError extends ToolkitError {
    constructor() {
        super(`${featureName} UI panel failed to load`, { code: 'PanelLoadFailed' })
    }
}

export class WorkspaceFolderNotFoundError extends ToolkitError {
    constructor() {
        super(`Workspace folder was not found. Open a workspace to continue using ${featureName}`, {
            code: 'WorkspaceFolderNotFound',
        })
    }
}

export class UserMessageNotFoundError extends ToolkitError {
    constructor() {
        super(`Message was not found`, { code: 'MessageNotFound' })
    }
}

export class SelectedFolderNotInWorkspaceFolderError extends ToolkitError {
    constructor() {
        super(
            `The selected folder is not in an opened workspace folder. Add the selected folder to the workspace or pick a new folder`,
            {
                code: 'SelectedFolderNotInWorkspaceFolder',
            }
        )
    }
}

export class PrepareRepoFailedError extends ToolkitError {
    constructor() {
        super('Unable to prepare repository for uploading', { code: 'PrepareRepoFailed' })
    }
}

export class ContentLengthError extends ToolkitError {
    constructor() {
        super(
            'The project you have selected for source code is too large to use as context. Please select a different folder to use for this conversation',
            { code: 'ContentLengthError' }
        )
    }
}

const denyListedErrors: string[] = ['Deserialization error', 'Inaccessible host']

export function createUserFacingErrorMessage(message: string) {
    if (denyListedErrors.some(err => message.includes(err))) {
        return `${featureName} API request failed`
    }
    return message
}
