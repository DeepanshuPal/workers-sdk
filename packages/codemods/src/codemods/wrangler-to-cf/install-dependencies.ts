import { readFile } from "node:fs/promises";
import path from "node:path";
import { installPackages } from "@cloudflare/cli-shared-helpers/packages";
import {
	BunPackageManager,
	getInstalledPackageVersion,
	NpmPackageManager,
	NubPackageManager,
	PnpmPackageManager,
	YarnPackageManager,
} from "@cloudflare/workers-utils";
import { fileExists } from "../../files";
import type { MigrationBundler } from "./types";
import type { PackageManager } from "@cloudflare/workers-utils";

const VITE_PLUGIN = "@cloudflare/vite-plugin";
const VITE_PLUGIN_SPECIFIER = `${VITE_PLUGIN}@beta`;
const VITE_PLUGIN_VERSION_PATTERN =
	/^2\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VITE_PLUGIN_RANGE_PATTERN =
	/^(?:(?:\^|~)?2(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|>=2\.0\.0-0 <3\.0\.0-0|beta)$/;

const PACKAGE_MANAGERS = [
	NubPackageManager,
	PnpmPackageManager,
	YarnPackageManager,
	BunPackageManager,
	NpmPackageManager,
] as const satisfies readonly PackageManager[];
const NPM_LOCK_FILES = [
	"npm-shrinkwrap.json",
	...NpmPackageManager.lockFiles,
] as const;

interface PackageJson {
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
	packageManager?: unknown;
	workspaces?: unknown;
}

type DependencyInstallPlan =
	| {
			action:
				| "already-installed"
				| "missing-manifest"
				| "skipped-ancestor-package";
	  }
	| {
			action: "unreadable-manifest";
			reason?: string;
	  }
	| {
			action: "install";
			devPackages: string[];
			isWorkspaceRoot: boolean;
			packageDirectory: string;
			productionPackages: string[];
	  };

interface DependencyInstallOptions {
	dryRun: boolean;
}

interface DependencyInstallResult {
	changedFiles: string[];
	requiresInstall: boolean;
}

interface DeclaredPackageManager {
	packageManager: PackageManager;
	version?: string;
}

interface DetectedPackageManager {
	directory: string;
	packageManager: PackageManager;
	version?: string;
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
	return JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;
}

function hasCfDependency(packageJson: PackageJson): boolean {
	return (
		packageJson.dependencies?.cf !== undefined ||
		packageJson.devDependencies?.cf !== undefined
	);
}

function needsVitePluginUpgrade(
	packageJson: PackageJson,
	projectDirectory: string
): boolean {
	const declaredVersion =
		packageJson.dependencies?.[VITE_PLUGIN] ??
		packageJson.devDependencies?.[VITE_PLUGIN];
	if (typeof declaredVersion !== "string") {
		return true;
	}

	const installedVersion = getInstalledPackageVersion(
		VITE_PLUGIN,
		projectDirectory
	);
	const compatibleInstalledVersion =
		installedVersion !== undefined &&
		VITE_PLUGIN_VERSION_PATTERN.test(installedVersion);
	if (
		!VITE_PLUGIN_RANGE_PATTERN.test(declaredVersion) &&
		!(
			/^(?:workspace:|file:|link:|portal:)/.test(declaredVersion) &&
			compatibleInstalledVersion
		)
	) {
		return true;
	}
	return installedVersion !== undefined && !compatibleInstalledVersion;
}

/** Finds the nearest package manifest at or above the migration directory. */
export async function findPackageJson(
	projectDirectory: string
): Promise<string | undefined> {
	let currentDirectory = projectDirectory;
	while (true) {
		const packageJsonPath = path.join(currentDirectory, "package.json");
		if (await fileExists(packageJsonPath)) {
			return packageJsonPath;
		}

		const parentDirectory = path.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return undefined;
		}
		currentDirectory = parentDirectory;
	}
}

function getDeclaredPackageManager(
	packageJson: PackageJson
): DeclaredPackageManager | undefined {
	if (typeof packageJson.packageManager !== "string") {
		return undefined;
	}

	const versionSeparator = packageJson.packageManager.lastIndexOf("@");
	const packageManagerName =
		versionSeparator > 0
			? packageJson.packageManager.slice(0, versionSeparator)
			: packageJson.packageManager;
	const packageManager = PACKAGE_MANAGERS.find(
		({ type }) => type === packageManagerName
	);
	if (!packageManager) {
		return undefined;
	}

	return {
		packageManager,
		version:
			versionSeparator > 0
				? packageJson.packageManager.slice(versionSeparator + 1)
				: undefined,
	};
}

async function hasLockFile(
	directory: string,
	packageManager: PackageManager
): Promise<boolean> {
	const lockFilesExist = await Promise.all(
		getLockFiles(packageManager).map((lockFile) =>
			fileExists(path.join(directory, lockFile))
		)
	);
	return lockFilesExist.some(Boolean);
}

function getLockFiles(packageManager: PackageManager): readonly string[] {
	return packageManager.type === "npm"
		? NPM_LOCK_FILES
		: packageManager.lockFiles;
}

async function findLockFileDirectory(
	packageDirectory: string,
	packageManager: PackageManager
): Promise<string | undefined> {
	let currentDirectory = packageDirectory;
	while (true) {
		if (await hasLockFile(currentDirectory, packageManager)) {
			return currentDirectory;
		}

		const parentDirectory = path.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return undefined;
		}
		currentDirectory = parentDirectory;
	}
}

async function detectPackageManager(
	packageDirectory: string
): Promise<DetectedPackageManager> {
	let currentDirectory = packageDirectory;
	while (true) {
		const packageJsonPath = path.join(currentDirectory, "package.json");
		if (await fileExists(packageJsonPath)) {
			const declared = getDeclaredPackageManager(
				await readPackageJson(packageJsonPath)
			);
			if (declared) {
				return {
					directory:
						(await findLockFileDirectory(
							packageDirectory,
							declared.packageManager
						)) ?? currentDirectory,
					...declared,
				};
			}
		}

		for (const packageManager of PACKAGE_MANAGERS) {
			if (await hasLockFile(currentDirectory, packageManager)) {
				return { directory: currentDirectory, packageManager };
			}
		}

		const parentDirectory = path.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return {
				directory: packageDirectory,
				packageManager: NpmPackageManager,
			};
		}
		currentDirectory = parentDirectory;
	}
}

function usesTextBunLockfile(version: string | undefined): boolean {
	if (!version) {
		return true;
	}

	const match = /^(\d+)\.(\d+)/.exec(version);
	if (!match) {
		return true;
	}
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	return major > 1 || (major === 1 && minor >= 2);
}

async function getPlannedLockFiles(
	packageDirectory: string,
	packageManager: PackageManager,
	packageManagerVersion: string | undefined
): Promise<string[]> {
	const lockFilePaths = getLockFiles(packageManager).map((lockFile) =>
		path.join(packageDirectory, lockFile)
	);
	const existingLockFiles = (
		await Promise.all(
			lockFilePaths.map(async (lockFilePath) => ({
				exists: await fileExists(lockFilePath),
				lockFilePath,
			}))
		)
	)
		.filter(({ exists }) => exists)
		.map(({ lockFilePath }) => lockFilePath);

	if (existingLockFiles.length > 0) {
		return existingLockFiles;
	}
	if (packageManager.type === "bun") {
		return [
			path.join(
				packageDirectory,
				usesTextBunLockfile(packageManagerVersion) ? "bun.lock" : "bun.lockb"
			),
		];
	}
	if (packageManager.type === "npm") {
		return [path.join(packageDirectory, "package-lock.json")];
	}
	return lockFilePaths.length === 1 ? lockFilePaths : [];
}

async function readFiles(
	filePaths: string[]
): Promise<Map<string, Buffer | undefined>> {
	return new Map(
		await Promise.all(
			filePaths.map(
				async (filePath) =>
					[
						filePath,
						(await fileExists(filePath)) ? await readFile(filePath) : undefined,
					] as const
			)
		)
	);
}

function getChangedFiles(
	before: Map<string, Buffer | undefined>,
	after: Map<string, Buffer | undefined>
): string[] {
	return Array.from(before).flatMap(([filePath, beforeContents]) => {
		const afterContents = after.get(filePath);
		if (beforeContents === undefined && afterContents === undefined) {
			return [];
		}
		if (
			beforeContents === undefined ||
			afterContents === undefined ||
			!beforeContents.equals(afterContents)
		) {
			return [filePath];
		}
		return [];
	});
}

/**
 * Plans migration dependency installation without modifying the project.
 *
 * @param projectDirectory Directory containing the Wrangler configuration.
 *
 * @param bundler Bundler selected for the migrated project.
 *
 * @returns The dependency action required by the migrated project.
 */
export async function planDependencyInstallation(
	projectDirectory: string,
	bundler: MigrationBundler
): Promise<DependencyInstallPlan> {
	const packageJsonPath = await findPackageJson(projectDirectory);
	if (!packageJsonPath) {
		return { action: "missing-manifest" };
	}

	const packageDirectory = path.dirname(packageJsonPath);
	if (packageDirectory !== projectDirectory) {
		return { action: "skipped-ancestor-package" };
	}
	let packageJson: PackageJson;
	try {
		packageJson = await readPackageJson(packageJsonPath);
	} catch (error) {
		return {
			action: "unreadable-manifest",
			...(error instanceof Error ? { reason: error.message } : {}),
		};
	}
	const devPackages = hasCfDependency(packageJson) ? [] : ["cf@latest"];
	const productionPackages: string[] = [];
	if (
		bundler === "vite" &&
		needsVitePluginUpgrade(packageJson, projectDirectory)
	) {
		if (packageJson.dependencies?.[VITE_PLUGIN] !== undefined) {
			productionPackages.push(VITE_PLUGIN_SPECIFIER);
		} else {
			devPackages.push(VITE_PLUGIN_SPECIFIER);
		}
	}
	if (devPackages.length === 0 && productionPackages.length === 0) {
		return { action: "already-installed" };
	}
	const isWorkspaceRoot =
		packageJson.workspaces !== undefined ||
		(await fileExists(path.join(packageDirectory, "pnpm-workspace.yaml")));

	return {
		action: "install",
		devPackages,
		isWorkspaceRoot,
		packageDirectory,
		productionPackages,
	};
}

/**
 * Installs migration dependencies using a dependency installation plan.
 *
 * @param plan Planned package manager invocation for the migrated project.
 * @param options Whether to report planned changes without installing.
 *
 * @returns Package files changed or expected to change during installation.
 */
export async function installMigrationDependencies(
	plan: Extract<DependencyInstallPlan, { action: "install" }>,
	options: DependencyInstallOptions
): Promise<DependencyInstallResult> {
	const { devPackages, isWorkspaceRoot, packageDirectory, productionPackages } =
		plan;
	const {
		directory: lockFileDirectory,
		packageManager,
		version,
	} = await detectPackageManager(packageDirectory);
	const lockFilePaths = options.dryRun
		? await getPlannedLockFiles(lockFileDirectory, packageManager, version)
		: getLockFiles(packageManager).map((lockFile) =>
				path.join(lockFileDirectory, lockFile)
			);
	const packageFilePaths = [
		path.join(packageDirectory, "package.json"),
		...lockFilePaths,
	];
	if (options.dryRun) {
		return {
			changedFiles: packageFilePaths,
			requiresInstall: true,
		};
	}

	const before = await readFiles(packageFilePaths);

	if (devPackages.length > 0) {
		await installPackages(packageManager.type, devPackages, {
			cwd: packageDirectory,
			dev: true,
			isWorkspaceRoot,
		});
	}
	if (productionPackages.length > 0) {
		await installPackages(packageManager.type, productionPackages, {
			cwd: packageDirectory,
			isWorkspaceRoot,
		});
	}

	return {
		changedFiles: getChangedFiles(before, await readFiles(packageFilePaths)),
		requiresInstall: false,
	};
}
