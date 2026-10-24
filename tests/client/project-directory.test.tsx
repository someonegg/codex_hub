import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectDirectory } from "../../src/client/components/ProjectDirectory";

// @vitest-environment jsdom

function Field() {
  const [value, setValue] = useState("");
  return (
    <form>
      <ProjectDirectory
        value={value}
        projects={[{ project: "/projects/atlas" }, { project: "/projects/reader" }]}
        disabled={false}
        onChange={setValue}
      />
      <button type="submit">Create</button>
    </form>
  );
}

describe("project directory suggestions", () => {
  it("shows full paths in the page, filters and selects without submitting", () => {
    render(<Field />);
    const input = screen.getByRole("combobox");
    expect(input).not.toHaveAttribute("list");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.change(input, { target: { value: "reader" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: "/projects/reader" }));
    expect(input).toHaveValue("/projects/reader");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.blur(input, { relatedTarget: screen.getByRole("button", { name: "Create" }) });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports arrow selection, Enter, Escape and unmatched custom directories", () => {
    render(<Field />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/projects/reader");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/projects/reader");
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "/new/project" } });
    expect(input).toHaveValue("/new/project");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
