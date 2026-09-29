import path from "node:path";
import { fileExists } from "../../files";
import { ensureCleanGitWorktree } from "../../git";
import { convertWranglerConfig } from "./config-converter";
import { findSecretFiles, readWranglerConfig } from "./config-reader";
import {
	renderCloudflareConfig,
	renderWranglerConfig,
} from "./config-renderer";
import {
	cleanupMigrationOutputs,
	rewriteMigrationOutput,
	writeMigrationOutputs,
} from "./file-writer";
import { createFollowUp } from "./follow-ups";
import {
	installMigrationDependencies,
	planDependencyInstallation,
} from "./install-dependencies";
import { assertCompatibleWranglerVersion } from "./wrangler-version";
import type {
	MigrationFollowUp,
	WranglerToCfMigrationOptions,
	WranglerToCfMigrationResult,
} from "./types";

export type {
	MigrationFollowUp,
	WranglerToCfMigrationOptions,
	WranglerToCfMigrationResult,
} from "./types";

async function assertTargetsDoNotExist(filePaths: string[]): Promise<void> {
	const targetsExist = await Promise.all(filePaths.map(fileExists));
	const existingTarget = filePaths.find((_, index) => targetsExist[index]);
	if (existingTarget === undefined) {
		return;
	}

	throw new Error(
		`Cannot migrate because ${existingTarget} already exists. Inspect and finish the existing migration; it will not be overwritten. Automated agents should read its TODOs and ask the user about unresolved choices.`
	);
}

function formatDependencies(packages: string[]): string {
	return packages.map((packageName) => `\`${packageName}\``).join(" and ");
}

/**
 * Migrates one exact Wrangler configuration file to the new cf configuration.
 *
 * @param configPath Path to a Wrangler JSON, JSONC, or TOML configuration file.
 * @param options Optional bundler selection and write-safety controls.
 *
 * @returns Generated file paths and any follow-up work left for the caller.
 */
export async function migrateWranglerToCf(
	configPath: string,
	options: WranglerToCfMigrationOptions = {}
): Promise<WranglerToCfMigrationResult> {
	const {
		bundler = "vite",
		dryRun = false,
		force = false,
		installDependencies = true,
	} = options;
	if (bundler !== "vite" && bundler !== "wrangler") {
		throw new Error(
			`Unsupported bundler "${String(bundler)}". Expected "vite" or "wrangler".`
		);
	}

	const absoluteConfigPath = path.resolve(configPath);
	const projectDirectory = path.dirname(absoluteConfigPath);
	const cloudflareConfigPath = path.join(
		projectDirectory,
		"cloudflare.config.ts"
	);

	await assertTargetsDoNotExist([cloudflareConfigPath]);
	if (!dryRun) {
		await ensureCleanGitWorktree(projectDirectory, force);
	}

	const [rawConfig, secretFiles] = await Promise.all([
		readWranglerConfig(absoluteConfigPath),
		findSecretFiles(projectDirectory),
	]);
	const convertedConfig = convertWranglerConfig(
		rawConfig,
		bundler,
		secretFiles
	);
	const dependencyPlan = await planDependencyInstallation(
		projectDirectory,
		bundler
	);
	const requiredPackages =
		dependencyPlan.action === "install"
			? [...dependencyPlan.devPackages, ...dependencyPlan.productionPackages]
			: [
					"cf@latest",
					...(bundler === "vite" ? ["@cloudflare/vite-plugin@beta"] : []),
				];
	const dependencyNames = formatDependencies(requiredPackages);
	const dependencyKind =
		requiredPackages.length === 1 ? "a dev dependency" : "dev dependencies";
	if (dependencyPlan.action === "missing-manifest") {
		convertedConfig.followUps.push(
			createFollowUp(
				"cf-install-missing-manifest",
				`No package.json was found. Create or locate the package that owns this Worker, then install ${dependencyNames} as ${dependencyKind} before using the generated configuration.`
			)
		);
	}
	if (dependencyPlan.action === "skipped-ancestor-package") {
		convertedConfig.followUps.push(
			createFollowUp(
				"cf-install-skipped",
				`An ancestor package.json was found, but it was not modified because it may belong to another project. Install ${dependencyNames} as ${dependencyKind} in the package that owns this Worker.`
			)
		);
	}
	if (installDependencies && dependencyPlan.action === "unreadable-manifest") {
		const reason = dependencyPlan.reason
			? ` Package manifest error: ${dependencyPlan.reason}`
			: "";
		convertedConfig.followUps.push(
			createFollowUp(
				"cf-install-failed",
				`The local package.json could not be read, so migration dependencies could not be installed automatically. Resolve the reported package.json error, then install ${dependencyNames} before using the generated configuration.${reason}`
			)
		);
	}
	if (
		!installDependencies &&
		(dependencyPlan.action === "install" ||
			dependencyPlan.action === "unreadable-manifest")
	) {
		convertedConfig.followUps.push(
			createFollowUp(
				"cf-install-disabled",
				`Automatic dependency installation was disabled. Install ${dependencyNames} before using the generated configuration.`
			)
		);
	}
	const followUps = [...convertedConfig.followUps];
	const cloudflareConfig = renderCloudflareConfig(convertedConfig);
	const wranglerConfig = renderWranglerConfig(convertedConfig);

	const outputs = new Map<string, string>([
		[cloudflareConfigPath, cloudflareConfig],
	]);
	if (wranglerConfig) {
		outputs.set(
			path.join(projectDirectory, "wrangler.config.ts"),
			wranglerConfig
		);
	}
	const changedFiles = Array.from(outputs.keys());
	let requiresInstall = dependencyPlan.action !== "already-installed";

	await assertTargetsDoNotExist(Array.from(outputs.keys()));

	if (wranglerConfig) {
		assertCompatibleWranglerVersion(projectDirectory);
	}
	if (!dryRun) {
		await writeMigrationOutputs(outputs);
	}
	if (installDependencies && dependencyPlan.action === "install") {
		let dependencyFollowUp: MigrationFollowUp | undefined;
		try {
			const installResult = await installMigrationDependencies(dependencyPlan, {
				dryRun,
			});
			changedFiles.push(...installResult.changedFiles);
			requiresInstall = installResult.requiresInstall;
		} catch (error) {
			if (dryRun) {
				throw error;
			}
			const reason =
				error instanceof Error ? ` Installation failed: ${error.message}` : "";
			dependencyFollowUp = createFollowUp(
				"cf-install-failed",
				`The generated configuration was written, but migration dependencies could not be installed automatically. Install ${dependencyNames} with your package manager before using it.${reason}`
			);
			requiresInstall = true;
		}

		if (dependencyFollowUp) {
			followUps.push(dependencyFollowUp);
			const updatedCloudflareConfig = renderCloudflareConfig({
				...convertedConfig,
				followUps,
			});
			outputs.set(cloudflareConfigPath, updatedCloudflareConfig);
			try {
				await rewriteMigrationOutput(
					cloudflareConfigPath,
					updatedCloudflareConfig
				);
			} catch (error) {
				await cleanupMigrationOutputs(outputs.keys(), error);
			}
		}
	}

	return {
		changedFiles: changedFiles.map((filePath) =>
			path.relative(projectDirectory, filePath)
		),
		followUps,
		requiresInstall,
		status: followUps.some(({ blocking }) => blocking)
			? "needs-intervention"
			: "complete",
	};
}
