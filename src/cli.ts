/** Minimal argument parsing – no dependency needed for a handful of flags. */

export interface CliOptions {
  configPath?: string;
  /** Print the server table and exit. */
  list: boolean;
  /** Connect to this server directly (no TUI). */
  connect?: string;
  via?: "hostname" | "ipv4";
  printConfigPath: boolean;
  help: boolean;
  version: boolean;
}

export const USAGE = `shh – a terminal UI for your SSH servers

Usage:
  shh [options]

Options:
  -c, --config <path>     Use this config file (default: $SHH_CONFIG or
                          $XDG_CONFIG_HOME/shh/config.yaml)
  -l, --list              Print the servers as a table and exit
  -C, --connect <name>    Connect to <name> without opening the UI
      --ipv4              With --connect: use the IPv4 address
      --hostname          With --connect: use the hostname
      --config-path       Print the resolved config path and exit
  -h, --help              Show this help
  -V, --version           Show the version

Keys inside the UI: press ? for the full list.
`;

export class CliError extends Error {}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { list: false, printConfigPath: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) throw new CliError(`${arg} needs a value`);
      return value;
    };
    const eq = arg.indexOf("=");
    const [flag, inline] = arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const value = () => inline ?? next();
    switch (flag) {
      case "-c":
      case "--config":
        options.configPath = value();
        break;
      case "-l":
      case "--list":
        options.list = true;
        break;
      case "-C":
      case "--connect":
        options.connect = value();
        break;
      case "--ipv4":
        options.via = "ipv4";
        break;
      case "--hostname":
        options.via = "hostname";
        break;
      case "--config-path":
        options.printConfigPath = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-V":
      case "--version":
        options.version = true;
        break;
      default:
        throw new CliError(`Unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}
