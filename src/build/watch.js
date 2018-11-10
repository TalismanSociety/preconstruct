// @flow
import { Package, StrictPackage } from "../package";
import { watch } from "rollup";
import chalk from "chalk";
import path from "path";
import ms from "ms";
import * as fs from "fs-extra";
import { getRollupConfigs } from "./config";
import { type Aliases, getAliases } from "./aliases";
import { toUnsafeRollupConfig } from "./rollup";
import { success, info } from "../logger";
import { successes } from "../messages";
import { writeOtherFiles } from "./utils";

function relativePath(id) {
  return path.relative(process.cwd(), id);
}

async function watchPackage(pkg: StrictPackage, aliases: Aliases) {
  const _configs = getRollupConfigs(pkg, aliases);
  await fs.remove(path.join(pkg.directory, "dist"));
  let configs = _configs.map(config => {
    return { ...toUnsafeRollupConfig(config.config), output: config.outputs };
  });
  const watcher = watch(configs);
  let reject;
  let errPromise = new Promise((resolve, _reject) => {
    reject = _reject;
  });
  let startResolve;
  let startPromise = new Promise(resolve => {
    startResolve = resolve;
  });
  watcher.on("event", event => {
    // https://github.com/rollup/rollup/blob/aed954e4e6e8beabd47268916ff0955fbb20682d/bin/src/run/watch.ts#L71-L115
    switch (event.code) {
      case "FATAL": {
        reject(event.error);
        break;
      }

      case "ERROR": {
        reject(event.error);
        break;
      }

      case "START":
        startResolve();
        break;

      case "BUNDLE_START": {
        info(
          chalk.cyan(
            `bundles ${chalk.bold(
              typeof event.input === "string"
                ? relativePath(event.input)
                : event.input.map(relativePath).join(", ")
            )} → ${chalk.bold(event.output.map(relativePath).join(", "))}...`
          ),
          pkg
        );
        break;
      }

      case "BUNDLE_END": {
        writeOtherFiles(
          pkg,
          event.result.modules[0].originalCode.includes("@flow")
            ? Object.keys(event.result.exports).includes("default")
              ? "all"
              : "named"
            : false
        );

        info(
          chalk.green(
            `created ${chalk.bold(
              event.output.map(relativePath).join(", ")
            )} in ${chalk.bold(ms(event.duration))}`
          ),
          pkg
        );
        break;
      }

      case "END": {
        info("waiting for changes...", pkg);
      }
    }
  });
  return { error: errPromise, start: startPromise };
}

async function retryableWatch(
  pkg: StrictPackage,
  aliases: Aliases,
  getPromises: ({ start: Promise<*> }) => mixed,
  depth: number
) {
  try {
    let { error, start } = await watchPackage(pkg, aliases);
    if (depth === 0) {
      getPromises({ start });
    }
    await error;
  } catch (err) {
    if (err instanceof Promise) {
      await err;
      await retryableWatch(pkg, aliases, getPromises, depth + 1);
      return;
    }
    throw err;
  }
}

export default async function build(directory: string) {
  let pkg = await Package.create(directory);
  // do more stuff with checking whether the repo is using yarn workspaces or bolt

  let packages = await pkg.packages();
  if (packages === null) {
    let strictPackage = pkg.strict();
    await retryableWatch(
      strictPackage,
      {},
      async ({ start }) => {
        await start;
        success(successes.startedWatching);
      },
      0
    );
  } else {
    let strictPackages = packages.map(x => x.strict());
    let aliases = getAliases(strictPackages);
    let startCount = 0;
    await Promise.all(
      strictPackages.map(pkg =>
        retryableWatch(
          pkg,
          aliases,
          async ({ start }) => {
            await start;
            startCount++;
            if (startCount === strictPackages.length) {
              success(successes.startedWatching);
            }
          },
          0
        )
      )
    );
  }
}