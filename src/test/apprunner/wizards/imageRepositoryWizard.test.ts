/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppRunner } from 'aws-sdk'
import { createWizardTester, WizardTester } from '../../shared/wizards/wizardTestUtils'
import { AppRunnerImageRepositoryWizard, TaggedEcrRepository } from '../../../apprunner/wizards/imageRepositoryWizard'
import { EcrRepositoryForm } from '../../../shared/ui/common/ecrRepository'

describe('AppRunnerImageRepositoryWizard', function () {
    let tester: WizardTester<AppRunner.SourceConfiguration>
    let repoTester: WizardTester<AppRunner.ImageRepository>

    beforeEach(function () {
        const wizard = new AppRunnerImageRepositoryWizard({} as any, {} as any) // the clients will never be called
        tester = createWizardTester(wizard)
        repoTester = tester.ImageRepository
    })

    it('prompts for identifier, port, and environment variables', function () {
        repoTester.ImageIdentifier.assertShowFirst()
        repoTester.ImageConfiguration.Port.assertShowSecond()
        repoTester.ImageConfiguration.RuntimeEnvironmentVariables.assertShowThird()
        repoTester.assertShowCount(3)
    })

    it('sets image repository type', function () {
        repoTester.ImageRepositoryType.assertValue(undefined)
        repoTester.ImageIdentifier.applyInput('public.ecr.aws.com/testimage:latest')
        repoTester.ImageRepositoryType.assertValue('ECR_PUBLIC')
        repoTester.ImageIdentifier.applyInput('12351232424.dkr.ecr.us-east-1.amazonaws.com/testrepo:latest')
        repoTester.ImageRepositoryType.assertValue('ECR')
    })

    it('sets "AutoDeploymentsEnabled" to false by default', function () {
        tester.AutoDeploymentsEnabled.assertValue(false)
    })

    it('prompts for role if not public', function () {
        repoTester.ImageRepositoryType.applyInput('ECR')
        tester.AuthenticationConfiguration.AccessRoleArn.assertShow()

        repoTester.ImageRepositoryType.applyInput('ECR_PUBLIC')
        tester.AuthenticationConfiguration.AccessRoleArn.assertDoesNotShow()
    })
})

describe('EcrRepositoryForm', function () {
    let tester: WizardTester<{ repo: TaggedEcrRepository }>

    beforeEach(function () {
        const form = new EcrRepositoryForm({} as any) // ecr will never be called
        tester = createWizardTester(form)
    })

    it('asks for tag if not provided', function () {
        tester.repo.tag.assertDoesNotShow()
        tester.repo.applyInput({ repositoryName: 'name', repositoryArn: '', repositoryUri: '' })
        tester.repo.tag.assertShow()
    })

    it('skips tag step if given', function () {
        tester.repo.applyInput({ repositoryName: 'name', repositoryArn: '', repositoryUri: '', tag: 'latest' })
        tester.repo.tag.assertDoesNotShow()
    })
})
