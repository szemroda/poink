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

type SetParsedCommandLine = (result: ParsedCommandLine) => void;
type MapCommandArgs = (args: string[]) => string[];
type RegisterExecutable = (
  command: Command,
  mapArgs?: MapCommandArgs,
) => Command;

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
): ParsedCommandLine["globals"] {
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
  setResult: SetParsedCommandLine,
  mapArgs: MapCommandArgs = (args) => args,
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

function createExecutableRegistrar(
  rawArgs: string[],
  configuredDefaultFormat: OutputFormat,
  setResult: SetParsedCommandLine,
): RegisterExecutable {
  return (command, mapArgs) =>
    executable(command, rawArgs, configuredDefaultFormat, setResult, mapArgs);
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

function createCommandProgram(): Command {
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
  return program;
}

function registerUtilityCommands(
  program: Command,
  register: RegisterExecutable,
): void {
  register(program.command("help"), () => ["--help"]).description("Show help");
  register(program.command("version"), () => ["--version"]).description(
    "Show version",
  );
  register(program.command("capabilities"));
}

function registerSearchCommands(
  program: Command,
  register: RegisterExecutable,
): void {
  register(addSearchOptions(program.command("search <query>")));
  register(
    addSearchOptions(
      program
        .command("search-pack <queries...>")
        .option("--with-content")
        .option("--global-limit <n>", "", parseIntegerOption("--global-limit", 1)),
    ),
  );

  const taxonomy = program.command("taxonomy");
  register(taxonomy);
  register(taxonomy.command("list"));
  register(taxonomy.command("tree [rootId]"));
  register(taxonomy.command("get <id>"));
  register(
    taxonomy
      .command("search <query>")
      .option("--limit <n>", "", parseIntegerOption("--limit", 1))
      .option("--threshold <n>"),
  );
  register(
    taxonomy
      .command("add <id>")
      .option("--label <label>")
      .option("--broader <id>")
      .option("--definition <text>")
      .option("--alt-labels <labels>"),
  );
}

function registerLibraryCommands(
  program: Command,
  register: RegisterExecutable,
): void {
  const chunk = program.command("chunk");
  register(chunk);
  register(chunk.command("get <chunkId>"));

  const doc = program.command("doc");
  register(doc);
  register(
    doc.command("chunks <docId>").option("--page <n>", "", parseIntegerOption("--page", 1)),
  );

  const page = program.command("page");
  register(page);
  register(page.command("get <docId> <page>"));
  register(
    page
      .command("extract <docId> <pages>")
      .option("--output-format <formats>")
      .option("--output-dir <path>")
      .option("--png-width <pixels>"),
  );

  register(program.command("list").option("--tag <tag>"));
  register(program.command("read <idOrTitle>"));
  register(program.command("get <idOrTitle>"));
  register(program.command("remove <idOrTitle>"));
  register(program.command("tag <idOrTitle> <tags>"));
  register(program.command("stats"));
}

function registerConfigCommands(
  program: Command,
  register: RegisterExecutable,
): void {
  const config = program.command("config");
  register(config.option("--show-secrets"));
  register(config.command("show").option("--show-secrets"));
  register(config.command("schema"));
  register(config.command("get <path>").option("--show-secrets"));
  register(config.command("set <path> <value>").option("--show-secrets"));
}

function registerSetupCommands(
  program: Command,
  register: RegisterExecutable,
): void {
  const providers = program.command("providers");
  register(providers);
  register(
    providers
      .command("login")
      .option("--provider <provider>")
      .option("--device-auth")
      .option("--device-code"),
  );

  const setup = program.command("setup");
  register(setup);
  register(setup.command("init").option("--dry-run"));
  register(setup.command("config").option("--dry-run"));
}

function registerMaintenanceCommands(
  program: Command,
  register: RegisterExecutable,
): void {
  register(program.command("doctor").option("--fix").option("--deep"));
  register(program.command("check"));
  register(program.command("init"));
  register(program.command("repair"));
  register(
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
  );
  register(program.command("reindex").option("--clean").option("--doc <id>"));
  register(
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
  );
}

function registerServerCommands(
  program: Command,
  register: RegisterExecutable,
): void {
  register(program.command("mcp"));
  register(
    program
      .command("serve")
      .option("--host <host>")
      .option("--port <port>", "", parseIntegerOption("--port", 1, 65535))
      .option("--auth-token <token>"),
  );
}

function registerCommands(
  program: Command,
  register: RegisterExecutable,
): void {
  registerUtilityCommands(program, register);
  register(addDocumentDownloadOptions(program.command("add <pathOrUrl>")));
  registerSearchCommands(program, register);
  registerLibraryCommands(program, register);
  registerConfigCommands(program, register);
  registerSetupCommands(program, register);
  registerMaintenanceCommands(program, register);
  registerServerCommands(program, register);
}

export function parseCommandLine(
  rawArgs: string[],
  configuredDefaultFormat: OutputFormat = DEFAULT_CLI_OUTPUT_FORMAT,
): ParsedCommandLine {
  let parsed: ParsedCommandLine | undefined;
  const register = createExecutableRegistrar(
    rawArgs,
    configuredDefaultFormat,
    (result) => {
      parsed = result;
    },
  );
  const program = createCommandProgram();
  registerCommands(program, register);

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
