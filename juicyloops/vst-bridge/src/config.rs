//! Settings (port, allowed studio origins, the pairing token, extra plugin folders), kept as JSON in the user's
//! config folder, plus the command line that can override them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 47817;

/// The studios allowed to connect: its dev servers and the public site. `*` matches any run of characters.
pub fn default_origins() -> Vec<String> {
    ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*", "http://juicyloops.test", "https://juicyloops.daspete.at"]
        .iter()
        .map(|origin| origin.to_string())
        .collect()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub port: u16,
    pub allowed_origins: Vec<String>,
    /// The pairing token the studio must present. Made on first start.
    pub token: String,
    /// Folders scanned on top of the standard ones.
    pub extra_plugin_paths: Vec<PathBuf>,
    pub scan_clap: bool,
    pub scan_vst3: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { port: DEFAULT_PORT, allowed_origins: default_origins(), token: String::new(), extra_plugin_paths: Vec::new(), scan_clap: true, scan_vst3: true }
    }
}

/// Where the bridge keeps its settings and plugin cache.
pub fn config_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("JUICYLOOPS_BRIDGE_HOME") {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("Juicy Loops Bridge");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Application Support/Juicy Loops Bridge");
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
            return PathBuf::from(config).join("juicyloops-bridge");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".config/juicyloops-bridge");
        }
    }
    std::env::temp_dir().join("juicyloops-bridge")
}

impl Config {
    /// Reads the settings file, making it (with a new token) when there is none.
    pub fn load_or_create(path: &Path) -> std::io::Result<Config> {
        let mut config = match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str::<Config>(&text)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{}: {error}", path.display())))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(error) => return Err(error),
        };
        if normalize_token(&config.token).len() < 16 {
            config.token = new_token();
            config.save(path)?;
        }
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, text)?;
        restrict_permissions(&temporary);
        std::fs::rename(&temporary, path)
    }

    pub fn origin_allowed(&self, origin: &str) -> bool {
        self.allowed_origins.iter().any(|pattern| glob_matches(&pattern.to_ascii_lowercase(), &origin.to_ascii_lowercase()))
    }

    pub fn token_matches(&self, presented: &str) -> bool {
        let expected = normalize_token(&self.token);
        let presented = normalize_token(presented);
        // Constant time over the expected length.
        let mut difference = expected.len() ^ presented.len();
        for (index, byte) in expected.bytes().enumerate() {
            difference |= (byte ^ presented.as_bytes().get(index).copied().unwrap_or(0)) as usize;
        }
        !expected.is_empty() && difference == 0
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// `*` matches any run of characters (also none); everything else literally.
pub fn glob_matches(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|byte| *byte == b'*')
}

const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// A fresh token: 100 random bits as 20 Crockford base-32 characters in groups of four (`k7m2-9xq4-…`), easy to
/// copy and to read aloud.
pub fn new_token() -> String {
    let mut random = [0u8; 20];
    getrandom::fill(&mut random).expect("the system has no random source");
    let characters: Vec<char> = random.iter().map(|byte| ALPHABET[(*byte & 31) as usize] as char).collect();
    characters.chunks(4).map(|group| group.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

/// A token as typed: no dashes or spaces, lower case.
pub fn normalize_token(token: &str) -> String {
    token.chars().filter(|character| character.is_ascii_alphanumeric()).map(|character| character.to_ascii_lowercase()).collect()
}

/// Command-line options.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Options {
    pub port: Option<u16>,
    pub config_path: Option<PathBuf>,
    pub builtin_plugins: bool,
    pub headless: bool,
    pub no_scan: bool,
    pub reset_token: bool,
    pub plugin_paths: Vec<PathBuf>,
    pub allow_origins: Vec<String>,
    /// Internal: scan one file in this (child) process and print its plugins as JSON.
    pub scan_one: Option<(String, PathBuf)>,
    pub help: bool,
    pub version: bool,
}

pub const USAGE: &str = "juicyloops-bridge: plays desktop plugins (CLAP, VST3) in the Juicy Loops studio.

Usage: juicyloops-bridge [options]

  --port <n>            Listen on 127.0.0.1:<n> (default 47817).
  --config <file>       Settings file (default: the user's config folder).
  --allow-origin <o>    Also allow this studio origin (repeatable; `*` wildcards).
  --plugin-path <dir>   Also scan this folder (repeatable).
  --no-scan             Do not scan on start (use the cached list).
  --builtin-plugins     List the bridge's own test plugins too.
  --headless            No plugin windows (no display needed).
  --reset-token         Make a new pairing token (the studio must pair again).
  --version, --help
";

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut options = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--port" => options.port = Some(value("--port")?.parse().map_err(|_| "--port needs a number".to_string())?),
            "--config" => options.config_path = Some(PathBuf::from(value("--config")?)),
            "--allow-origin" => options.allow_origins.push(value("--allow-origin")?),
            "--plugin-path" => options.plugin_paths.push(PathBuf::from(value("--plugin-path")?)),
            "--no-scan" => options.no_scan = true,
            "--builtin-plugins" => options.builtin_plugins = true,
            "--headless" => options.headless = true,
            "--reset-token" => options.reset_token = true,
            "--scan-one" => {
                let format = value("--scan-one")?;
                let path = value("--scan-one")?;
                options.scan_one = Some((format, PathBuf::from(path)));
            }
            "--help" | "-h" => options.help = true,
            "--version" | "-V" => options.version = true,
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_match_the_allow_list() {
        let config = Config::default();
        assert!(config.origin_allowed("http://127.0.0.1:5199"));
        assert!(config.origin_allowed("http://localhost:5173"));
        assert!(config.origin_allowed("https://juicyloops.daspete.at"));
        assert!(config.origin_allowed("HTTP://JUICYLOOPS.TEST"));
        assert!(!config.origin_allowed("https://evil.example"));
        assert!(!config.origin_allowed("https://juicyloops.daspete.at.evil.example"));
        assert!(!config.origin_allowed("null"));
        assert!(!config.origin_allowed("http://127.0.0.1.evil.example"), "the port wildcard must not swallow a host");
    }

    #[test]
    fn glob() {
        assert!(glob_matches("a*c", "abbbc"));
        assert!(glob_matches("*", ""));
        assert!(!glob_matches("a*c", "abcd"));
        assert!(glob_matches("https://*.example.com", "https://x.y.example.com"));
    }

    #[test]
    fn tokens_are_compared_as_typed() {
        let mut config = Config { token: new_token(), ..Config::default() };
        assert_eq!(config.token.len(), 24);
        assert!(config.token_matches(&config.token.clone()));
        assert!(config.token_matches(&format!(" {} ", config.token.to_uppercase().replace('-', ""))));
        assert!(!config.token_matches(""));
        assert!(!config.token_matches(&config.token[..10]));
        config.token.clear();
        assert!(!config.token_matches(""), "no token set means nobody gets in");
    }

    #[test]
    fn settings_are_made_once_and_kept() {
        let dir = std::env::temp_dir().join(format!("jl-bridge-config-{}", std::process::id()));
        let path = dir.join("config.json");
        let _ = std::fs::remove_dir_all(&dir);
        let first = Config::load_or_create(&path).unwrap();
        let second = Config::load_or_create(&path).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.port, DEFAULT_PORT);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn arguments() {
        let options = parse_args(["--port", "9000", "--builtin-plugins", "--allow-origin", "http://x:*"].map(String::from)).unwrap();
        assert_eq!(options.port, Some(9000));
        assert!(options.builtin_plugins);
        assert_eq!(options.allow_origins, vec!["http://x:*".to_string()]);
        assert!(parse_args(["--port"].map(String::from)).is_err());
        assert!(parse_args(["--bogus"].map(String::from)).is_err());
    }
}
