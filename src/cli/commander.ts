import { Command, CommanderError } from "commander";
import { DEFAULT_CLI_OUTPUT_FORMAT, type LogLevel, type OutputFormat } from "../agent/protocol.js";
import { getLogLevel } from "../logger.js";
import { CLIError } from "./runner.js";
import { mapCommanderError } from "./errors.js";
import {
  addOutputOptions,
  parseIntegerOption,
  type CommandOutputOptions,
} from "./options.js";

export type ParsedCommandLine = {
  args: string[];
  options: Record<string, unknown>;
  globals: {
    format: OutputFormat;
    configuredDefaultFormat: OutputFormat;
    pretty: boolean;
    verbose: boolean;
    logLevel: LogLevel;
  };
};

function kebabCaseOptionName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function commandOptions(command: Command): CommandOutputOptions & Record<string, unknown> {
  const options = command.opts() as CommandOutputOptions & Record<string, unknown>;
  const expanded: CommandOutputOptions & Record<string, unknown> = { ...options };
  for (const [key, value] of Object.entries(options)) {
    expanded[kebabCaseOptionName(key)] = value;
  }
  return expanded;
}

function commandGlobals(
  options: CommandOutputOptions,
  configuredDefaultFormat: OutputFormat,
) {
  return {
    format: options.format ?? configuredDefaultFormat,
    configuredDefaultFormat,
    pretty: options.pretty === true,
    verbose: options.verbose === true,
    logLevel: options.logLevel ?? getLogLevel(),
  };
}

function outputOptionsFromRawArgs(rawArgs: string[]): CommandOutputOptions {
  const options: CommandOutputOptions = {};
  if (rawArgs[0]?.startsWith("--")) return options;

  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--pretty") options.pretty = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length) as OutputFormat;
    } else if (arg === "--format") {
      options.format = rawArgs[i + 1] as OutputFormat;
      i++;
    } else if (arg.startsWith("--log-level=")) {
      options.logLevel = arg.slice("--log-level=".length) as LogLevel;
    } else if (arg === "--log-level") {
      options.logLevel = rawArgs[i + 1] as LogLevel;
      i++;
    }
  }

  return options;
}

function stripOutputOptions(args: string[]): string[] {
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      arg === "--pretty" ||
      arg === "--verbose" ||
      arg.startsWith("--format=") ||
      arg.startsWith("--log-level=")
    ) {
      continue;
    }
    if (arg === "--format" || arg === "--log-level") {
      i++;
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

function executable(
  command: Command,
  rawArgs: string[],
  configuredDefaultFormat: OutputFormat,
  setResult: (result: ParsedCommandLine) => void,
  mapArgs: (args: string[]) => string[] = (args) => args,
): Command {
  addOutputOptions(command);
  return command.action(() => {
    const options = {
      ...commandOptions(command),
      ...outputOptionsFromRawArgs(rawArgs),
    };
    setResult({
      args: mapArgs(stripOutputOptions(rawArgs)),
      options,
      globals: commandGlobals(options, configuredDefaultFormat),
    });
  });
}

function addDocumentDownloadOptions(command: Command): Command {
  return command
    .option("--tags <tags>")
    .option("--title <title>")
    .option("--enrich")
    .option("--visuals")
    .option("--auto-tag")
    .option("--provider <provider>")
    .option("--max-file-size <size>")
    .option("--download-timeout <duration>")
    .option("--max-redirects <n>", "", parseIntegerOption("--max-redirects", 0))
    .option("--allow-private-network")
    .option("--allowed-private-network-hosts <hosts>");
}

function addSearchOptions(command: Command): Command {
  return command
    .option("--limit <n>", "", parseIntegerOption("--limit", 1))
    .option("--tag <tag>")
    .option("--fts")
    .option("--expand <chars>", "", parseIntegerOption("--expand", 0, 4000))
    .option("--docs-only")
    .option("--concepts-only")
    .option("--include-clusters");
}

function addRootHelp(program: Command): void {
  program
    .helpOption("-h, --help", "display help for command")
    .configureOutput({
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
    });
}

export function parseCommandLine(
  rawArgs: string[],
  configuredDefaultFormat: OutputFormat = DEFAULT_CLI_OUTPUT_FORMAT,
): ParsedCommandLine {
  let parsed: ParsedCommandLine | undefined;
  const setResult = (result: ParsedCommandLine) => {
    parsed = result;
  };

  const program = new Command("poink");
  program
    .exitOverride()
    .helpOption(false)
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
      outputError: () => undefined,
    });

  executable(program.command("help"), rawArgs, configuredDefaultFormat, setResult, () => [
    "--help",
  ]).description("Show help");
  executable(program.command("version"), rawArgs, configuredDefaultFormat, setResult, () => [
    "--version",
  ]).description("Show version");
  executable(program.command("capabilities"), rawArgs, configuredDefaultFormat, setResult);
  executable(addDocumentDownloadOptions(program.command("add <pathOrUrl>")), rawArgs, configuredDefaultFormat, setResult);
  executable(addSearchOptions(program.command("search <query>")), rawArgs, configuredDefaultFormat, setResult);
  executable(
    addSearchOptions(
      program
        .command("search-pack <queries...>")
        .option("--with-content")
        .option("--global-limit <n>", "", parseIntegerOption("--global-limit", 1)),
    ),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );

  const taxonomy = program.command("taxonomy");
  executable(taxonomy, rawArgs, configuredDefaultFormat, setResult);
  executable(taxonomy.command("list"), rawArgs, configuredDefaultFormat, setResult);
  executable(taxonomy.command("tree [rootId]"), rawArgs, configuredDefaultFormat, setResult);
  executable(taxonomy.command("get <id>"), rawArgs, configuredDefaultFormat, setResult);
  executable(
    taxonomy
      .command("search <query>")
      .option("--limit <n>", "", parseIntegerOption("--limit", 1))
      .option("--threshold <n>"),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );
  executable(
    taxonomy
      .command("add <id>")
      .option("--label <label>")
      .option("--broader <id>")
      .option("--definition <text>")
      .option("--alt-labels <labels>"),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );

  const chunk = program.command("chunk");
  executable(chunk, rawArgs, configuredDefaultFormat, setResult);
  executable(chunk.command("get <chunkId>"), rawArgs, configuredDefaultFormat, setResult);

  const doc = program.command("doc");
  executable(doc, rawArgs, configuredDefaultFormat, setResult);
  executable(
    doc.command("chunks <docId>").option("--page <n>", "", parseIntegerOption("--page", 1)),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );

  const page = program.command("page");
  executable(page, rawArgs, configuredDefaultFormat, setResult);
  executable(page.command("get <docId> <page>"), rawArgs, configuredDefaultFormat, setResult);

  executable(program.command("list").option("--tag <tag>"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("read <idOrTitle>"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("get <idOrTitle>"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("remove <idOrTitle>"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("tag <idOrTitle> <tags>"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("stats"), rawArgs, configuredDefaultFormat, setResult);

  const config = program.command("config");
  executable(config.option("--show-secrets"), rawArgs, configuredDefaultFormat, setResult);
  executable(config.command("show").option("--show-secrets"), rawArgs, configuredDefaultFormat, setResult);
  executable(config.command("schema"), rawArgs, configuredDefaultFormat, setResult);
  executable(config.command("get <path>").option("--show-secrets"), rawArgs, configuredDefaultFormat, setResult);
  executable(config.command("set <path> <value>").option("--show-secrets"), rawArgs, configuredDefaultFormat, setResult);

  const providers = program.command("providers");
  executable(providers, rawArgs, configuredDefaultFormat, setResult);
  executable(
    providers
      .command("login")
      .option("--provider <provider>")
      .option("--device-auth")
      .option("--device-code"),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );

  const setup = program.command("setup");
  executable(setup, rawArgs, configuredDefaultFormat, setResult);
  executable(setup.command("init").option("--dry-run"), rawArgs, configuredDefaultFormat, setResult);
  executable(setup.command("config").option("--dry-run"), rawArgs, configuredDefaultFormat, setResult);

  executable(program.command("doctor").option("--fix"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("check"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("init"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("repair"), rawArgs, configuredDefaultFormat, setResult);
  executable(
    program
      .command("ingest <directories...>")
      .option("--enrich")
      .option("--visuals")
      .option("--auto-tag")
      .option("--tags <tags>")
      .option("--sample <n>", "", parseIntegerOption("--sample", 1))
      .option("--no-progress")
      .option("--recursive")
      .option("--no-recursive"),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );
  executable(
    program.command("reindex").option("--clean").option("--doc <id>"),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );
  executable(
    program
      .command("rechunk")
      .option("--dry-run")
      .option("--doc <id>")
      .option("--tag <tag>")
      .option("--include-missing")
      .option("--max-docs <n>", "", parseIntegerOption("--max-docs", 1))
      .option("--max-chunks <n>", "", parseIntegerOption("--max-chunks", 1))
      .option("--all")
      .option("--visuals"),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );
  executable(program.command("mcp"), rawArgs, configuredDefaultFormat, setResult);
  executable(
    program
      .command("serve")
      .option("--host <host>")
      .option("--port <port>", "", parseIntegerOption("--port", 1, 65535))
      .option("--auth-token <token>"),
    rawArgs,
    configuredDefaultFormat,
    setResult,
  );
  executable(program.command("export"), rawArgs, configuredDefaultFormat, setResult);
  executable(program.command("import"), rawArgs, configuredDefaultFormat, setResult);

  try {
    program.parse(rawArgs, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw mapCommanderError(error);
    }
    throw error;
  }

  if (!parsed) {
    throw new CLIError("UNKNOWN_COMMAND", "No command provided");
  }
  return parsed;
}

export function renderRootHelp(): void {
  const program = new Command("poink");
  addRootHelp(program);
  program.description("Local document knowledge base with semantic search, enrichment, and MCP support.");
  program.addHelpText("after", "\nUse `poink help --format json` for a machine-readable help envelope.");
  program.help();
}
