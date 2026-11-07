import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectDirectory } from "../../src/client/components/ProjectDirectory";

// @vitest-environment jsdom

function Field({
  projects = [{ project: "/projects/atlas" }, { project: "/projects/reader" }],
  initial = "/projects/atlas",
  disabled = false,
}) {
  const [value, setValue] = useState(initial);
  return (
    <ProjectDirectory value={value} projects={projects} disabled={disabled} onChange={setValue} />
  );
}

describe("project directory selection", () => {
  it("selects existing paths without exposing or focusing a text input", () => {
    render(<Field />);
    const select = screen.getByRole("combobox", { name: "Project directory" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveValue("/projects/atlas");
    fireEvent.change(select, { target: { value: "/projects/reader" } });
    expect(select).toHaveValue("/projects/reader");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("requires an explicit custom selection, allows typing a known path, and returns to selection", () => {
    render(<Field />);
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "custom" } });
    const input = screen.getByRole("textbox", { name: "Custom directory" });
    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
    expect(input).toBeRequired();
    fireEvent.change(input, { target: { value: "/projects/atlas" } });
    expect(input).toHaveValue("/projects/atlas");
    fireEvent.change(input, { target: { value: "/new/project" } });
    fireEvent.change(select, { target: { value: "/projects/reader" } });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(select).toHaveValue("/projects/reader");
  });

  it("accepts a directory when there are no known projects", () => {
    render(<Field projects={[]} initial="" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Project directory" });
    fireEvent.change(input, { target: { value: "/new/project" } });
    expect(input).toHaveValue("/new/project");
  });

  it("preserves an unknown initial directory and disables both controls while busy", () => {
    render(<Field initial="/external/project" disabled />);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("/external/project");
    expect(screen.getByRole("textbox")).toBeDisabled();
  });
});
